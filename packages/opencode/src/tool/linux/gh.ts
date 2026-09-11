import path from "path"
import { Effect, Schema } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { InstanceState } from "@/effect/instance-state"
import { Tool } from "../tool"
import { exec, report, resolveWorkdirWithConfig, resourceWithWorkdir, Workdir } from "./exec"

export const Parameters = Schema.Struct({
  args: Schema.Array(Schema.String).annotate({
    description:
      "The gh subcommand and its arguments as an argv array (e.g. [\"pr\",\"view\"], [\"repo\",\"create\",\"name\"], " +
      "[\"api\",\"repos/owner/repo\",\"--method\",\"GET\"]). Structured argv only — NO shell string, NO pipes or " +
      "redirects.",
  }),
  workdir: Workdir,
})

export type Verb = "read" | "modify" | "delete" | "create"

export type Classification = {
  verb: Verb
  resource: string
  network: boolean
  subcommand: string
  dangerous?: boolean
  unknown?: boolean
}

const GLOBAL_VALUE = new Set(["-R", "--repo", "--hostname"])
const GLOBAL_INLINE_PREFIXES = ["--repo=", "--hostname="]

function splitGlobals(args: readonly string[]): { subcommand: string; rest: string[] } {
  let i = 0
  while (i < args.length) {
    const token = args[i]
    if (token === "--") {
      i++
      break
    }
    if (GLOBAL_VALUE.has(token)) {
      i += 2
      continue
    }
    if (GLOBAL_INLINE_PREFIXES.some((prefix) => token.startsWith(prefix))) {
      i++
      continue
    }
    if (token.startsWith("-")) {
      i++
      continue
    }
    break
  }
  return { subcommand: args[i] ?? "", rest: args.slice(i + 1) }
}

function resourceFromArgs(args: readonly string[], fallback: string): string {
  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (token === "--repo" || token === "-R") {
      const value = args[i + 1]
      if (value) return value
      continue
    }
    if (token.startsWith("--repo=")) {
      const value = token.slice("--repo=".length)
      if (value) return value
    }
  }
  return fallback
}

export function dangerousArgv(args: readonly string[]): string | undefined {
  const subcommand = splitGlobals(args).subcommand
  if (subcommand === "alias") return "alias"
  if (subcommand === "extension" || subcommand === "ext") return subcommand
  return undefined
}

export function validateArgv(args: readonly string[]): void {
  const bad = dangerousArgv(args)
  if (bad) throw new Error(`gh: '${bad}' is not permitted (command-execution vector)`)
}

const READ_ACTIONS = new Set(["view", "list", "status", "diff", "checks"])
const MODIFY_ACTIONS = new Set(["create", "edit", "merge", "comment", "review", "rerun"])
const DELETE_ACTIONS = new Set(["close", "delete"])
const KNOWN_SUBCOMMANDS = new Set(["pr", "issue", "repo", "release", "run", "workflow", "api"])

function firstAction(rest: readonly string[]): string {
  for (const token of rest) {
    if (!token.startsWith("-")) return token
  }
  return ""
}

function methodFromArgs(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (token === "-X" || token === "--method") {
      const value = args[i + 1]
      if (value) return value.toUpperCase()
      continue
    }
    if (token.startsWith("--method=")) return token.slice("--method=".length).toUpperCase()
    if (token.startsWith("-X") && token.length > 2) return token.slice(2).toUpperCase()
  }
  return undefined
}

export function classify(args: readonly string[], resource = "repo"): Classification {
  const resolved = resourceFromArgs(args, resource)
  const { subcommand, rest } = splitGlobals(args)
  const dangerous = dangerousArgv(args) !== undefined
  const base = dangerous
    ? { resource: resolved, subcommand, network: true, dangerous: true as const }
    : { resource: resolved, subcommand, network: true }

  if (subcommand === "api") {
    const method = methodFromArgs(rest)
    if (method === "GET") return { ...base, verb: "read" }
    return { ...base, verb: "modify" }
  }

  if (subcommand === "repo" && firstAction(rest) === "create") return { ...base, verb: "create" }

  const action = firstAction(rest)
  if (READ_ACTIONS.has(action)) return { ...base, verb: "read" }
  if (DELETE_ACTIONS.has(action)) return { ...base, verb: "delete" }
  if (MODIFY_ACTIONS.has(action)) return { ...base, verb: "modify" }

  if (KNOWN_SUBCOMMANDS.has(subcommand)) return { ...base, verb: "modify" }

  return { ...base, verb: "modify", unknown: true }
}

export const GhTool = Tool.define(
  "gh",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    return {
      description:
        "Run gh with structured argv (no shell). Provide the subcommand and args as an array. Returns command output " +
        "plus a semantic { verb, resource, network, subcommand } classification in metadata.",
      parameters: Parameters,
      execute: (params: { args: readonly string[]; workdir?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          if (params.args.length === 0) throw new Error("gh requires a subcommand")
          const workdir = yield* resolveWorkdirWithConfig(ctx, instance.directory, params.workdir)
          const cwd = workdir.cwd

          validateArgv(params.args)

          const classification = classify(params.args, resourceWithWorkdir("repo", path.relative(instance.directory, cwd) || "."))
          yield* ctx.ask({
            permission: classification.verb === "read" ? "read" : "edit",
            patterns: ["gh:" + (classification.subcommand || "?")],
            always: [],
            metadata: { classification, workdir: cwd },
          })

          const result = yield* exec(
            spawner,
            "gh",
            [...params.args],
            instance.directory,
            params.workdir,
            30_000,
            workdir.extraRoots,
          )
          const shaped = report({
            binary: "gh",
            result,
            title: params.args.join(" "),
            success: `gh ${classification.subcommand || "command"} completed`,
          })
          return {
            ...shaped,
            metadata: { ...shaped.metadata, classification },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
