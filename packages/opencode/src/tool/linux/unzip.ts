import fs from "node:fs"
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
      "Run unzip with structured argv (no shell). Provide unzip arguments as an array. Absolute paths, traversal, " +
      "and symlink operands are denied.",
  }),
  workdir: Workdir,
})

export type Verb = "read" | "modify"

export type Classification = {
  verb: Verb
  resource: string
  network: false
  dangerous?: true
}

const VALUE_OPTIONS = new Set(["-d", "-x"])

function isReadMode(args: readonly string[]): boolean {
  return args.some((token) => token === "-l" || token === "-t" || token === "-v" || token === "-z")
}

function isTraversal(token: string): boolean {
  return token === ".." || token.startsWith("../") || token.endsWith("/..") || token.includes("/../")
}

function pathViolation(token: string): string | undefined {
  if (path.isAbsolute(token)) return "absolute path"
  if (isTraversal(token)) return "path traversal"
  return undefined
}

function symlinkViolation(token: string, cwd: string): boolean {
  try {
    return fs.lstatSync(path.resolve(cwd, token)).isSymbolicLink()
  } catch {
    return false
  }
}

function checkPathToken(token: string, cwd: string): string | undefined {
  const violation = pathViolation(token)
  if (violation) return `${token} (${violation})`
  if (symlinkViolation(token, cwd)) return `${token} (symlink)`
  return undefined
}

export function dangerousArgv(args: readonly string[], cwd = process.cwd()): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (VALUE_OPTIONS.has(token)) {
      const value = args[i + 1]
      if (value) {
        const bad = checkPathToken(value, cwd)
        if (bad) return bad
      }
      i++
      continue
    }
    if (token.startsWith("-")) continue
    const bad = checkPathToken(token, cwd)
    if (bad) return bad
  }
  return undefined
}

export function validateArgv(args: readonly string[], cwd = process.cwd()): void {
  const bad = dangerousArgv(args, cwd)
  if (bad) throw new Error(`unzip: '${bad}' is not permitted (absolute path, traversal, or symlink)`)
}

export function classify(args: readonly string[], cwd = process.cwd(), resource = "archive"): Classification {
  const base = dangerousArgv(args, cwd) ? { resource, network: false as const, dangerous: true as const } : { resource, network: false as const }
  return { ...base, verb: isReadMode(args) ? "read" : "modify" }
}

function permissionPatterns(args: readonly string[]) {
  const values: string[] = ["unzip"]
  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (VALUE_OPTIONS.has(token)) {
      if (args[i + 1]) values.push(args[i + 1])
      i++
      continue
    }
    if (token.startsWith("-")) continue
    values.push(token)
  }
  return [...values, ...sensitivePatterns(values)]
}

export const UnzipTool = Tool.define(
  "unzip",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    return {
      description:
        "Run unzip with structured argv (no shell). Lists or extracts archives while denying absolute paths, " +
        "traversal, and symlink operands.",
      parameters: Parameters,
      execute: (params: { args: readonly string[]; workdir?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          if (params.args.length === 0) throw new Error("unzip requires arguments")
          const workdir = yield* resolveWorkdirWithConfig(ctx, instance.directory, params.workdir)
          const cwd = workdir.cwd
          validateArgv(params.args, cwd)

          const classification = classify(params.args, cwd, resourceWithWorkdir("archive", path.relative(instance.directory, cwd) || "."))
          yield* ctx.ask({
            permission: classification.verb === "read" ? "read" : "edit",
            patterns: permissionPatterns(params.args),
            always: [],
            metadata: { args: params.args, classification, workdir: cwd },
          })

          const result = yield* exec(
            spawner,
            "unzip",
            [...params.args],
            instance.directory,
            params.workdir,
            30_000,
            workdir.extraRoots,
          )
          const shaped = report({
            binary: "unzip",
            result,
            title: params.args.join(" "),
            success: "unzip completed",
          })
          return {
            ...shaped,
            metadata: { ...shaped.metadata, classification },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
