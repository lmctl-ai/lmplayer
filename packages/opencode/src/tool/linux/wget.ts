import { Effect, Schema } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { InstanceState } from "@/effect/instance-state"
import { Tool } from "../tool"
import { exec, report } from "./exec"

export const Parameters = Schema.Struct({
  args: Schema.Array(Schema.String).annotate({
    description:
      "Run wget with structured argv (no shell). Provide wget arguments as an array. Network/read use only; output " +
      "to paths, input-file, and file:// URLs are denied.",
  }),
})

export type Classification = {
  verb: "read"
  resource: "url"
  network: true
  dangerous?: true
}

function isFileUrl(token: string): boolean {
  return token.toLowerCase().startsWith("file://")
}

export function dangerousArgv(args: readonly string[]): string | undefined {
  for (const token of args) {
    if (token === "-O" || token === "--output-document" || token.startsWith("--output-document=")) return token
    if (token.startsWith("-O") && token.length > 2) return token
    if (token === "-i" || token === "--input-file" || token.startsWith("--input-file=")) return token
    if (token.startsWith("-i") && token.length > 2) return token
    if (isFileUrl(token)) return token
  }
  return undefined
}

export function validateArgv(args: readonly string[]): void {
  const bad = dangerousArgv(args)
  if (bad) throw new Error(`wget: '${bad}' is not permitted (output path, input file, or file URL)`)
}

export function classify(args: readonly string[]): Classification {
  if (dangerousArgv(args)) return { verb: "read", resource: "url", network: true, dangerous: true }
  return { verb: "read", resource: "url", network: true }
}

export const WgetTool = Tool.define(
  "wget",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    return {
      description:
        "Run wget with structured argv (no shell). Network/read use only; output to paths, input-file, and file:// " +
        "URLs are denied.",
      parameters: Parameters,
      execute: (params: { args: readonly string[] }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          if (params.args.length === 0) throw new Error("wget requires arguments")
          validateArgv(params.args)

          const classification = classify(params.args)
          yield* ctx.ask({
            permission: "read",
            patterns: ["wget"],
            always: [],
            metadata: { args: params.args, classification },
          })

          const result = yield* exec(spawner, "wget", [...params.args], instance.directory)
          const shaped = report({
            binary: "wget",
            result,
            title: params.args.join(" "),
            success: "wget completed",
          })
          return {
            ...shaped,
            metadata: { ...shaped.metadata, classification },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
