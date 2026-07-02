import { Effect, Schema } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { InstanceState } from "@/effect/instance-state"
import { Tool } from "../tool"
import { exec, report } from "./exec"

export const Parameters = Schema.Struct({
  args: Schema.Array(Schema.String).annotate({
    description:
      "Run curl with structured argv (no shell). Provide curl arguments as an array. Network/read use only; output " +
      "to paths, file:// URLs, config files, and uploads are denied.",
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
  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (token === "-o" || token === "--output") return token
    if (token.startsWith("--output=")) return token
    if (token === "-K" || token === "--config" || token.startsWith("--config=")) return token
    if (token === "-T" || token === "--upload-file" || token.startsWith("--upload-file=")) return token
    if (token.startsWith("-T") && token.length > 2) return token
    if (isFileUrl(token)) return token
  }
  return undefined
}

export function validateArgv(args: readonly string[]): void {
  const bad = dangerousArgv(args)
  if (bad) throw new Error(`curl: '${bad}' is not permitted (output path, file URL, config file, or upload)`)
}

export function classify(args: readonly string[]): Classification {
  if (dangerousArgv(args)) return { verb: "read", resource: "url", network: true, dangerous: true }
  return { verb: "read", resource: "url", network: true }
}

export const CurlTool = Tool.define(
  "curl",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    return {
      description:
        "Run curl with structured argv (no shell). Network/read use only; output to paths, file:// URLs, config " +
        "files, and uploads are denied.",
      parameters: Parameters,
      execute: (params: { args: readonly string[] }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          if (params.args.length === 0) throw new Error("curl requires arguments")
          validateArgv(params.args)

          const classification = classify(params.args)
          yield* ctx.ask({
            permission: "read",
            patterns: ["curl"],
            always: [],
            metadata: { args: params.args, classification },
          })

          const result = yield* exec(spawner, "curl", [...params.args], instance.directory)
          const shaped = report({
            binary: "curl",
            result,
            title: params.args.join(" "),
            success: "curl completed",
          })
          return {
            ...shaped,
            metadata: { ...shaped.metadata, classification },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
