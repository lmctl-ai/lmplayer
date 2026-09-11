import path from "path"
import { Effect, Option, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { Config } from "@/config/config"
import { assertExternalDirectoryEffect } from "../external-directory"
import type { Tool } from "../tool"

// Structured wrapper around a real Linux binary. This is the whole point of the
// linux tool batch: instead of a free-form shell string (bash), each tool takes
// TYPED params and spawns the real binary directly (NO shell), so calls are
// parseable and permissionable. We iterate from here.
//
// Spawns `binary` with the given argv, collects stdout/stderr + the exit code,
// and bounds pathological hangs with `timeoutMs`. Callers decide how to treat a
// non-zero exit (typically fail the tool with a clear message).
export type ExecResult = { stdout: string; stderr: string; code: number; args: string[] }

export const Workdir = Schema.optional(Schema.String).annotate({
  description:
    "Optional working directory for the command. External directories require external_directory permission. When tool_workdir.extra_roots is configured, the directory must be inside the workspace or a configured root.",
})

function insideRoot(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

export function resolveWorkdir(
  root: string,
  workdir?: string,
  options?: {
    extraRoots?: readonly string[]
  },
): string {
  const workspaceRoot = path.resolve(root)
  const resolved = workdir
    ? path.isAbsolute(workdir)
      ? path.resolve(workdir)
      : path.resolve(workspaceRoot, workdir)
    : workspaceRoot
  if (options?.extraRoots === undefined) return resolved
  const roots = [workspaceRoot, ...(options?.extraRoots ?? []).map((item) => path.resolve(item))]
  if (roots.some((allowed) => insideRoot(allowed, resolved))) return resolved
  throw new Error(`workdir '${workdir}' resolves outside the workspace root`)
}

export const resolveWorkdirWithConfig = Effect.fn("LinuxTool.resolveWorkdirWithConfig")(function* (
  ctx: Tool.Context,
  root: string,
  workdir?: string,
) {
  const config = yield* Effect.serviceOption(Config.Service)
  const loaded = Option.isNone(config) ? undefined : yield* config.value.get()
  const extraRoots = loaded?.tool_workdir?.extra_roots
  const cwd = resolveWorkdir(root, workdir, { extraRoots })
  yield* assertExternalDirectoryEffect(ctx, cwd, { kind: "directory" })
  return { cwd, extraRoots }
})

export function resourceWithWorkdir(resource: string, scope?: string): string {
  if (!scope || scope === ".") return resource
  return `${resource}:${scope}`
}

export const exec = Effect.fn("LinuxTool.exec")(function* (
  spawner: ChildProcessSpawner["Service"],
  binary: string,
  args: string[],
  root: string,
  workdir?: string,
  timeoutMs = 30_000,
  extraRoots?: readonly string[],
) {
  const cwd = resolveWorkdir(root, workdir, { extraRoots })
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(ChildProcess.make(binary, args, { cwd, stdin: "ignore" }))
      const [stdout, stderr, code] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      )
      return { stdout, stderr, code: code ?? 0, args } satisfies ExecResult
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: `${timeoutMs} millis`,
      orElse: () => Effect.die(new Error(`${binary} timed out after ${timeoutMs}ms`)),
    }),
    Effect.orDie,
  )
})

// Shared result shaping: fail the tool on non-zero exit with a clear message,
// otherwise return the command output as the tool result.
export function report(input: { binary: string; result: ExecResult; title: string; success: string }) {
  if (input.result.code !== 0) {
    const detail = input.result.stderr.trim() || input.result.stdout.trim() || "(no output)"
    throw new Error(`${input.binary} failed (exit ${input.result.code}): ${detail}`)
  }
  const output = [input.result.stdout, input.result.stderr]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n")
  return {
    title: input.title,
    // `args` is surfaced so the `--` option terminator (flag-injection guard) is
    // observable/assertable, not just implied.
    metadata: {
      exit: input.result.code,
      stdout: input.result.stdout,
      stderr: input.result.stderr,
      args: input.result.args,
    },
    output: output || input.success,
  }
}
