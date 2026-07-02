import fs from "node:fs"
import path from "path"
import { Effect, Schema } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { InstanceState } from "@/effect/instance-state"
import { Tool } from "../tool"
import { exec, report } from "./exec"

export const Parameters = Schema.Struct({
  args: Schema.Array(Schema.String).annotate({
    description:
      "Run tar with structured argv (no shell). Provide tar arguments as an array, e.g. " +
      "[\"-cf\",\"archive.tar\",\"src\"]. Absolute paths, traversal, symlinks, command filters, and external " +
      "compressor commands are denied.",
  }),
})

export type Verb = "read" | "create" | "modify"

export type Classification = {
  verb: Verb
  resource: "archive"
  network: false
  dangerous?: true
}

const VALUE_OPTIONS = new Set(["-f", "--file", "-C", "--directory", "--exclude", "-T", "--files-from"])
const DENIED_OPTIONS = new Set(["--to-command", "-I", "--use-compress-program"])

function hasCreate(args: readonly string[]): boolean {
  return args.some((token) => token === "--create" || token === "-c" || (/^-[^-]*c/.test(token) && !token.startsWith("--")))
}

function hasExtract(args: readonly string[]): boolean {
  return args.some((token) => token === "--extract" || token === "--get" || token === "-x" || (/^-[^-]*x/.test(token) && !token.startsWith("--")))
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
    if (DENIED_OPTIONS.has(token) || token.startsWith("--to-command=") || token.startsWith("--use-compress-program=")) {
      return token
    }
    if (VALUE_OPTIONS.has(token)) {
      const value = args[i + 1]
      if (value) {
        const bad = checkPathToken(value, cwd)
        if (bad) return bad
      }
      i++
      continue
    }
    if (token.startsWith("--file=") || token.startsWith("--directory=") || token.startsWith("--files-from=")) {
      const bad = checkPathToken(token.slice(token.indexOf("=") + 1), cwd)
      if (bad) return bad
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
  if (bad) throw new Error(`tar: '${bad}' is not permitted (absolute path, traversal, symlink, or command vector)`)
}

export function classify(args: readonly string[], cwd = process.cwd()): Classification {
  const base = dangerousArgv(args, cwd) ? { resource: "archive" as const, network: false as const, dangerous: true as const } : { resource: "archive" as const, network: false as const }
  if (hasCreate(args)) return { ...base, verb: "create" }
  if (hasExtract(args)) return { ...base, verb: "modify" }
  return { ...base, verb: "read" }
}

export const TarTool = Tool.define(
  "tar",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    return {
      description:
        "Run tar with structured argv (no shell). Archives and extracts files while denying absolute paths, " +
        "traversal, symlinks, command filters, and external compressor commands.",
      parameters: Parameters,
      execute: (params: { args: readonly string[] }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          if (params.args.length === 0) throw new Error("tar requires arguments")
          validateArgv(params.args, instance.directory)

          const classification = classify(params.args, instance.directory)
          yield* ctx.ask({
            permission: classification.verb === "read" ? "read" : "edit",
            patterns: ["tar"],
            always: [],
            metadata: { args: params.args, classification },
          })

          const result = yield* exec(spawner, "tar", [...params.args], instance.directory)
          const shaped = report({
            binary: "tar",
            result,
            title: params.args.join(" "),
            success: "tar completed",
          })
          return {
            ...shaped,
            metadata: { ...shaped.metadata, classification },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
