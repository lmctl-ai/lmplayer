import { Effect, Schema } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import path from "path"
import { InstanceState } from "@/effect/instance-state"
import { Tool } from "../tool"
import { exec, report, resolveWorkdirWithConfig, resourceWithWorkdir, Workdir } from "./exec"

export const Parameters = Schema.Struct({
  args: Schema.Array(Schema.String).annotate({
    description:
      "The git subcommand and its arguments as an argv array (e.g. [\"status\"], [\"commit\",\"-m\",\"msg\"], " +
      "[\"push\",\"origin\",\"main\"], [\"diff\",\"--stat\"]). Structured argv only — NO shell string, NO pipes or " +
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
  // Present + true only when the subcommand is not in the known map. Callers
  // (policy) should treat unknown git commands conservatively.
  unknown?: boolean
  // Present + true when the argv carries a known command-execution vector
  // (e.g. `-c core.pager=...`, `--exec-path`, `filter-branch`). execute() hard
  // rejects these, but the flag is surfaced so lmprobe sees it too.
  dangerous?: boolean
}

// ---------------------------------------------------------------------------
// Hard deny-list: git can run arbitrary programs from argv ALONE (no shell), so
// this tool must not become a bash-equivalent escape hatch. These argv patterns
// are known command-execution vectors and are rejected in execute() BEFORE the
// permission ask / exec. Keep the checks in ONE place (`isDangerousToken` +
// `dangerousArgv`) so the list is easy to extend / relax to an allowlist later.
//
// NOTE (residual, for lmprobe): repository-local `!`-aliases in .git/config
// (`alias.x = !sh`) also execute programs, but they are NOT visible from argv —
// they cannot be blocked here. That surface needs a config-scanning policy.
// ---------------------------------------------------------------------------

// A single argv token that is a command-execution vector, regardless of position.
function isDangerousToken(a: string): boolean {
  // Hijack the directory git searches for its subcommand binaries.
  if (a === "--exec-path" || a.startsWith("--exec-path=")) return true
  // Run an attacker-chosen program as the pack transport (any position).
  if (a === "--upload-pack" || a.startsWith("--upload-pack=")) return true
  if (a === "--receive-pack" || a.startsWith("--receive-pack=")) return true
  return false
}

// Return the first offending token (or the `filter-branch` subcommand), else
// undefined. Exported for reuse (policy/tests).
export function dangerousArgv(args: readonly string[]): string | undefined {
  const prefix = dangerousGlobalPrefix(args)
  if (prefix) return prefix
  for (const a of args) if (isDangerousToken(a)) return a
  // `filter-branch` runs a user-supplied shell command per commit.
  if (splitGlobals(args).subcommand === "filter-branch") return "filter-branch"
  return undefined
}

function dangerousGlobalPrefix(args: readonly string[]): string | undefined {
  let i = 0
  while (i < args.length) {
    const token = args[i]
    if (token === "--") return undefined
    // Inline config injection: pre-subcommand `-c key=val` /
    // `--config-env key=ENV` can set core.pager, core.editor,
    // core.sshCommand, core.fsmonitor, core.hooksPath, alias.*, etc.
    if (token === "-c" || token === "--config-env" || token.startsWith("--config-env=")) return token
    if (token === "--exec-path" || token.startsWith("--exec-path=")) return token
    if (GLOBAL_VALUE.has(token)) {
      i += 2
      continue
    }
    if (GLOBAL_INLINE_PREFIXES.some((prefix) => token.startsWith(prefix))) {
      i++
      continue
    }
    if (GLOBAL_BOOL.has(token)) {
      i++
      continue
    }
    if (token.startsWith("-")) {
      i++
      continue
    }
    return undefined
  }
  return undefined
}

// Throwing guard used by execute(). Fails the tool with a clear message.
export function validateArgv(args: readonly string[]): void {
  const bad = dangerousArgv(args)
  if (bad) throw new Error(`git: '${bad}' is not permitted (command-execution vector)`)
}

// Global (pre-subcommand) options that take a following VALUE token.
const GLOBAL_VALUE = new Set(["-C", "--git-dir", "--work-tree", "--namespace", "-c", "--config-env"])
// Global options that are standalone booleans (no value).
const GLOBAL_BOOL = new Set([
  "-p",
  "--paginate",
  "--no-pager",
  "--bare",
  "--no-replace-objects",
  "--literal-pathspecs",
  "--exec-path",
])
// Inline (`--opt=value`) forms of the value-taking / exec-path globals.
const GLOBAL_INLINE_PREFIXES = ["--git-dir=", "--work-tree=", "--namespace=", "--config-env=", "--exec-path="]

// Skip leading global options to find the REAL subcommand and its args. So
// `["-C","/x","status"]` resolves to subcommand "status".
function splitGlobals(args: readonly string[]): { subcommand: string; rest: string[] } {
  let i = 0
  while (i < args.length) {
    const a = args[i]
    if (a === "--") {
      i++
      break
    }
    if (GLOBAL_VALUE.has(a)) {
      i += 2
      continue
    }
    if (GLOBAL_INLINE_PREFIXES.some((p) => a.startsWith(p))) {
      i++
      continue
    }
    if (GLOBAL_BOOL.has(a)) {
      i++
      continue
    }
    // Any other leading option is skipped conservatively as a global boolean so
    // the real subcommand is still located.
    if (a.startsWith("-")) {
      i++
      continue
    }
    break
  }
  return { subcommand: args[i] ?? "", rest: args.slice(i + 1) }
}

// Subcommands that are purely read/inspect. `branch`, `tag`, `remote`, `config`
// are context-sensitive (a bare/list invocation reads, but flags mutate) and are
// resolved in `classify` below rather than living in this set.
const READ = new Set([
  "status",
  "log",
  "diff",
  "show",
  "ls-files",
  "rev-parse",
  "blame",
  "describe",
  "cat-file",
  "whatchanged",
  "shortlog",
  "reflog",
])

// Local mutations (no network).
const MODIFY = new Set([
  "add",
  "commit",
  "checkout",
  "switch",
  "restore",
  "merge",
  "rebase",
  "reset",
  "stash",
  "cherry-pick",
  "revert",
  "mv",
  "am",
  "apply",
  "gc",
  "prune",
])

// Local deletions.
const DELETE = new Set(["rm"])

// Network operations: { verb, whether it creates }.
const NETWORK: Record<string, { verb: Verb }> = {
  push: { verb: "modify" },
  pull: { verb: "modify" },
  fetch: { verb: "modify" },
  clone: { verb: "create" },
}

function hasFlag(args: readonly string[], ...flags: string[]) {
  return args.some((a) => flags.includes(a))
}

// Parse an argv array into a semantic (verb, resource, network) classification.
// Exported so policy (lmprobe) and tests can reuse the exact same mapping. This
// is intentionally best-effort and conservative: an UNKNOWN subcommand is
// flagged and treated as a local `modify`.
export function classify(args: readonly string[], resource = "repo"): Classification {
  const { subcommand, rest } = splitGlobals(args)
  const dangerous = dangerousArgv(args) !== undefined
  // Surface `dangerous` on every branch (execute() still hard-stops on it).
  const base = dangerous ? { resource, subcommand, dangerous: true as const } : { resource, subcommand }

  // `push` — network mutation; `--delete`/`-d` removes a remote ref.
  if (subcommand === "push") {
    const del = hasFlag(rest, "--delete", "-d")
    return { ...base, verb: del ? "delete" : "modify", network: true }
  }

  // Other network subcommands (pull/fetch/clone).
  if (subcommand in NETWORK) {
    return { ...base, verb: NETWORK[subcommand].verb, network: true }
  }

  // `remote` — bare or `-v`/`show`/`get-url` reads; add/remove/set-url/rename mutate.
  // Add/set-url touch the network config for a named remote (treated as network).
  if (subcommand === "remote") {
    const write = hasFlag(rest, "add", "set-url", "remove", "rm", "rename", "prune", "set-head", "set-branches")
    if (!write) return { ...base, verb: "read", network: false }
    const del = hasFlag(rest, "remove", "rm", "prune")
    const network = hasFlag(rest, "add", "set-url")
    return { ...base, verb: del ? "delete" : "modify", network }
  }

  // `branch` — listing reads; `-d`/`-D` delete; anything else (create/rename/move) modifies.
  if (subcommand === "branch") {
    if (hasFlag(rest, "-d", "-D", "--delete")) return { ...base, verb: "delete", network: false }
    const listing =
      rest.length === 0 || hasFlag(rest, "-l", "--list", "-a", "-r", "--all", "--remotes", "--show-current")
    return { ...base, verb: listing ? "read" : "modify", network: false }
  }

  // `tag` — `-d` deletes; `-l`/`--list` (or bare) reads; otherwise creates a tag (modify).
  if (subcommand === "tag") {
    if (hasFlag(rest, "-d", "--delete")) return { ...base, verb: "delete", network: false }
    const listing = rest.length === 0 || hasFlag(rest, "-l", "--list")
    return { ...base, verb: listing ? "read" : "modify", network: false }
  }

  // `stash` — `drop`/`clear`/`pop` remove entries; `list`/`show` read; otherwise modify.
  if (subcommand === "stash") {
    if (hasFlag(rest, "drop", "clear")) return { ...base, verb: "delete", network: false }
    if (rest.length > 0 && hasFlag(rest, "list", "show")) return { ...base, verb: "read", network: false }
    return { ...base, verb: "modify", network: false }
  }

  // `config` — reads (`--get`/`--list`/`-l`) vs writes (`--unset` deletes, otherwise set).
  if (subcommand === "config") {
    if (hasFlag(rest, "--unset", "--unset-all", "--remove-section")) return { ...base, verb: "delete", network: false }
    const read = hasFlag(rest, "--get", "--get-all", "--get-regexp", "--list", "-l")
    return { ...base, verb: read ? "read" : "modify", network: false }
  }

  // `worktree list` only reads repository metadata; all other worktree
  // subcommands create, move, remove, or repair working trees.
  if (subcommand === "worktree") {
    if (rest[0] === "list") return { ...base, verb: "read", network: false }
    return { ...base, verb: "modify", network: false }
  }

  // `clean` — only ACTS with `-f`/`--force` (and deletes files); `-x`/`-d` extend
  // what it removes. Classify as delete when a force/extend flag is present.
  if (subcommand === "clean") {
    const acts = rest.some((t) => t === "--force" || (/^-[a-z]*[fx]/i.test(t) && !t.startsWith("--")))
    return { ...base, verb: acts ? "delete" : "modify", network: false }
  }

  // `init` creates a repository.
  if (subcommand === "init") return { ...base, verb: "create", network: false }

  if (READ.has(subcommand)) return { ...base, verb: "read", network: false }
  if (DELETE.has(subcommand)) return { ...base, verb: "delete", network: false }
  if (MODIFY.has(subcommand)) return { ...base, verb: "modify", network: false }

  // Unknown subcommand: conservative + flagged.
  return { ...base, verb: "modify", network: false, unknown: true }
}

// Structured `git`. The FLAGSHIP of the well-known-CLI approach: run the real
// git binary with structured argv (no shell), and carry a semantic (verb,
// resource, network) classification in metadata for the security policy to
// consume. Future semantic permission verbs come from `classify`.
export const GitTool = Tool.define(
  "git",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    return {
      description:
        "Run git with structured argv (no shell). Provide the subcommand and args as an array. Returns command " +
        "output plus a semantic { verb, resource, network, subcommand } classification in metadata.",
      parameters: Parameters,
      execute: (params: { args: readonly string[]; workdir?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          if (params.args.length === 0) throw new Error("git requires a subcommand")
          const workdir = yield* resolveWorkdirWithConfig(ctx, instance.directory, params.workdir)
          const cwd = workdir.cwd

          // HARD guard: reject known command-execution vectors from the raw argv
          // BEFORE any permission ask or spawning git. git can run arbitrary
          // programs via inline config / exec-path / pack transports.
          validateArgv(params.args)

          // Best-effort repo name for the resource: basename of the worktree root.
          // Kept simple; network ops still classify by subcommand, resource stays
          // the repo name unless a better signal is trivially available.
          const top = yield* topLevel(spawner, cwd)
          const resource = resourceWithWorkdir(top ?? "repo", path.relative(instance.directory, cwd) || ".")
          const classification = classify(params.args, resource)

          yield* ctx.ask({
            permission: classification.verb === "read" ? "read" : "edit",
            patterns: ["git:" + (classification.subcommand || "?")],
            always: [],
            metadata: { classification, args: params.args, workdir: cwd },
          })

          const result = yield* exec(
            spawner,
            "git",
            [...params.args],
            instance.directory,
            params.workdir,
            30_000,
            workdir.extraRoots,
          )
          const shaped = report({
            binary: "git",
            result,
            title: params.args.join(" "),
            success: `git ${classification.subcommand} completed`,
          })
          return {
            ...shaped,
            metadata: { ...shaped.metadata, classification },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// Resolve the repo top-level basename. Never fails the tool: a non-repo dir or a
// missing git just yields undefined and the caller falls back to "repo".
const topLevel = Effect.fn("GitTool.topLevel")(function* (
  spawner: ChildProcessSpawner["Service"],
  cwd: string,
) {
  const result = yield* exec(spawner, "git", ["rev-parse", "--show-toplevel"], cwd).pipe(
    Effect.catchCause(() => Effect.succeed(undefined)),
  )
  if (!result || result.code !== 0) return undefined
  const top = result.stdout.trim()
  return top ? path.basename(top) : undefined
})
