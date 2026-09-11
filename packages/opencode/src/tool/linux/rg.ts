import path from "path"
import { Effect, Schema } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { InstanceState } from "@/effect/instance-state"
import { Tool } from "../tool"
import { exec, report, resolveWorkdirWithConfig, resourceWithWorkdir, Workdir } from "./exec"
import { sensitivePatterns } from "./sensitive"

export const Parameters = Schema.Struct({
  args: Schema.Array(Schema.String).annotate({
    description:
      "Run ripgrep (rg) with structured argv (no shell). Provide rg arguments as an array, e.g. " +
      "[\"TODO\",\"src\",\"--glob\",\"*.ts\"]. Structured argv only — NO shell string, NO pipes or redirects.",
  }),
  workdir: Workdir,
})

export type Classification = {
  verb: "read"
  resource: string
  network: false
  dangerous?: true
}

function insideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function deniedPatternFile(args: readonly string[], cwd: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    const value = token === "-f" || token === "--file" ? args[i + 1] : token.startsWith("--file=") ? token.slice(7) : undefined
    if (!value) continue
    if (!insideRoot(cwd, path.isAbsolute(value) ? value : path.resolve(cwd, value))) return token
  }
  return undefined
}

export function dangerousArgv(args: readonly string[], cwd = process.cwd()): string | undefined {
  for (const token of args) {
    if (token === "--pre" || token.startsWith("--pre=")) return token
    if (token === "--pre-glob" || token.startsWith("--pre-glob=")) return token
    if (token === "--search-zip") return token
  }
  return deniedPatternFile(args, cwd)
}

export function validateArgv(args: readonly string[], cwd = process.cwd()): void {
  const bad = dangerousArgv(args, cwd)
  if (bad) throw new Error(`rg: '${bad}' is not permitted (preprocessor, archive, or outside-root pattern file)`)
}

export function classify(args: readonly string[], cwd = process.cwd(), resource = "filesystem"): Classification {
  if (dangerousArgv(args, cwd)) return { verb: "read", resource, network: false, dangerous: true }
  return { verb: "read", resource, network: false }
}

function readPatterns(args: readonly string[]) {
  const values: string[] = ["rg"]
  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (token === "-g" || token === "--glob" || token === "--iglob" || token === "--include" || token === "--exclude") {
      if (args[i + 1]) values.push(args[i + 1])
      i++
      continue
    }
    if (
      token.startsWith("--glob=") ||
      token.startsWith("--iglob=") ||
      token.startsWith("--include=") ||
      token.startsWith("--exclude=")
    ) {
      values.push(token.slice(token.indexOf("=") + 1))
      continue
    }
    if (token.startsWith("-")) continue
    values.push(token)
  }
  return [...values, ...sensitivePatterns(values)]
}

export const RgTool = Tool.define(
  "rg",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    return {
      description:
        "Run ripgrep (rg) with structured argv (no shell). Searches files and returns output plus a semantic " +
        "{ verb, resource, network } classification in metadata.",
      parameters: Parameters,
      execute: (params: { args: readonly string[]; workdir?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const workdir = yield* resolveWorkdirWithConfig(ctx, instance.directory, params.workdir)
          const cwd = workdir.cwd
          validateArgv(params.args, cwd)

          const classification = classify(
            params.args,
            cwd,
            resourceWithWorkdir("filesystem", path.relative(instance.directory, cwd) || "."),
          )
          yield* ctx.ask({
            permission: "read",
            patterns: readPatterns(params.args),
            always: [],
            metadata: { args: params.args, classification, workdir: cwd },
          })

          const result = yield* exec(
            spawner,
            "rg",
            [...params.args],
            instance.directory,
            params.workdir,
            30_000,
            workdir.extraRoots,
          )
          const shaped = report({
            binary: "rg",
            result,
            title: params.args.join(" ") || "rg",
            success: "rg completed",
          })
          return {
            ...shaped,
            metadata: { ...shaped.metadata, classification },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
