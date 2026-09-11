import path from "path"
import { Effect, Schema } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { InstanceState } from "@/effect/instance-state"
import { Tool } from "../tool"
import { assertExternalDirectoryEffect } from "../external-directory"
import { exec, report, resolveWorkdirWithConfig, resourceWithWorkdir, Workdir } from "./exec"
import { sensitivePatterns } from "./sensitive"

export const Parameters = Schema.Struct({
  args: Schema.Array(Schema.String).annotate({
    description:
      "The find command arguments as an argv array (for example [\".\",\"-name\",\"*.ts\",\"-type\",\"f\"]). " +
      "Pass paths and predicates exactly as separate argv tokens.",
  }),
  workdir: Workdir,
})

export type Classification = {
  verb: "read"
  resource: string
  dangerous?: true
}

const DENIED = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprintf", "-fprint", "-fprint0", "-fls"])

export function dangerousArgv(args: readonly string[]): string | undefined {
  for (const token of args) {
    if (DENIED.has(token)) return token
  }
  return undefined
}

export function validateArgv(args: readonly string[]): void {
  const bad = dangerousArgv(args)
  if (bad) throw new Error(`find: '${bad}' is not permitted (command-exec or destructive predicate)`)
}

function firstPathArg(args: readonly string[]): string {
  for (const token of args) {
    if (token === "--") break
    if (!token.startsWith("-")) return token
  }
  return "."
}

function readPatterns(args: readonly string[]) {
  const values: string[] = ["find"]
  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (token === "--") break
    if (token === "-name" || token === "-iname" || token === "-path" || token === "-ipath") {
      if (args[i + 1]) values.push(args[i + 1])
      i++
      continue
    }
    if (!token.startsWith("-")) values.push(token)
  }
  return [...values, ...sensitivePatterns(values)]
}

export function classify(args: readonly string[], resource = "filesystem"): Classification {
  const dangerous = dangerousArgv(args) !== undefined
  if (dangerous) return { verb: "read", resource, dangerous: true }
  return { verb: "read", resource }
}

export const FindTool = Tool.define(
  "find",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    return {
      description:
        "Run find with structured argv (no shell). Provide paths and predicates as an argv array; command-exec and destructive predicates are blocked.",
      parameters: Parameters,
      execute: (params: { args: readonly string[]; workdir?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const workdir = yield* resolveWorkdirWithConfig(ctx, instance.directory, params.workdir)
          const cwd = workdir.cwd

          validateArgv(params.args)

          const firstPath = firstPathArg(params.args)
          const abs = path.isAbsolute(firstPath) ? firstPath : path.resolve(cwd, firstPath)
          const classification = classify(params.args, resourceWithWorkdir("filesystem", path.relative(instance.directory, cwd) || "."))

          yield* assertExternalDirectoryEffect(ctx, abs, { kind: "directory" })
          yield* ctx.ask({
            permission: "read",
            patterns: readPatterns(params.args),
            always: [],
            metadata: { args: params.args, classification, workdir: cwd },
          })

          const result = yield* exec(
            spawner,
            "find",
            [...params.args],
            instance.directory,
            params.workdir,
            30_000,
            workdir.extraRoots,
          )
          const shaped = report({
            binary: "find",
            result,
            title: params.args.join(" ") || ".",
            success: "find completed",
          })
          return {
            ...shaped,
            metadata: { ...shaped.metadata, classification },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
