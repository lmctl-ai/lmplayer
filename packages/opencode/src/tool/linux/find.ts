import path from "path"
import { Effect, Schema } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { InstanceState } from "@/effect/instance-state"
import { Tool } from "../tool"
import { assertExternalDirectoryEffect } from "../external-directory"
import { exec, report } from "./exec"

export const Parameters = Schema.Struct({
  args: Schema.Array(Schema.String).annotate({
    description:
      "The find command arguments as an argv array (for example [\".\",\"-name\",\"*.ts\",\"-type\",\"f\"]). " +
      "Pass paths and predicates exactly as separate argv tokens.",
  }),
})

export type Classification = {
  verb: "read"
  resource: "filesystem"
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

export function classify(args: readonly string[]): Classification {
  const dangerous = dangerousArgv(args) !== undefined
  if (dangerous) return { verb: "read", resource: "filesystem", dangerous: true }
  return { verb: "read", resource: "filesystem" }
}

export const FindTool = Tool.define(
  "find",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    return {
      description:
        "Run find with structured argv (no shell). Provide paths and predicates as an argv array; command-exec and destructive predicates are blocked.",
      parameters: Parameters,
      execute: (params: { args: readonly string[] }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context

          validateArgv(params.args)

          const firstPath = firstPathArg(params.args)
          const abs = path.isAbsolute(firstPath) ? firstPath : path.resolve(instance.directory, firstPath)
          const classification = classify(params.args)

          yield* assertExternalDirectoryEffect(ctx, abs, { kind: "directory" })
          yield* ctx.ask({
            permission: "read",
            patterns: ["find"],
            always: [],
            metadata: { args: params.args, classification },
          })

          const result = yield* exec(spawner, "find", [...params.args], instance.directory)
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
