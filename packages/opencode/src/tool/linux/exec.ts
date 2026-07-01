import { Effect, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

// Structured wrapper around a real Linux binary. This is the whole point of the
// linux tool batch: instead of a free-form shell string (bash), each tool takes
// TYPED params and spawns the real binary directly (NO shell), so calls are
// parseable and permissionable. We iterate from here.
//
// Spawns `binary` with the given argv, collects stdout/stderr + the exit code,
// and bounds pathological hangs with `timeoutMs`. Callers decide how to treat a
// non-zero exit (typically fail the tool with a clear message).
export type ExecResult = { stdout: string; stderr: string; code: number; args: string[] }

export const exec = Effect.fn("LinuxTool.exec")(function* (
  spawner: ChildProcessSpawner["Service"],
  binary: string,
  args: string[],
  cwd: string,
  timeoutMs = 30_000,
) {
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
export function report(input: {
  binary: string
  result: ExecResult
  title: string
  success: string
}) {
  if (input.result.code !== 0) {
    const detail = input.result.stderr.trim() || input.result.stdout.trim() || "(no output)"
    throw new Error(`${input.binary} failed (exit ${input.result.code}): ${detail}`)
  }
  const output = [input.result.stdout, input.result.stderr].map((s) => s.trim()).filter(Boolean).join("\n")
  return {
    title: input.title,
    // `args` is surfaced so the `--` option terminator (flag-injection guard) is
    // observable/assertable, not just implied.
    metadata: { exit: input.result.code, stdout: input.result.stdout, stderr: input.result.stderr, args: input.result.args },
    output: output || input.success,
  }
}
