import { describe, expect } from "bun:test"
import path from "path"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../../src/agent/agent"
import { Git } from "@/git"
import { Config } from "@/config/config"
import { GitTool, classify, validateArgv, dangerousArgv } from "../../../src/tool/linux/git"
import { SessionID, MessageID } from "../../../src/session/schema"
import { TestInstance, tmpdirScoped } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import { Cause, Exit } from "effect"
import type { Tool } from "@/tool/tool"

const toolLayer = LayerNode.compile(
  LayerNode.group([CrossSpawnSpawner.node, FSUtil.node, Truncate.node, Agent.node, Git.node]),
)

const it = testEffect(toolLayer)
const itWithWorkdirConfig = testEffect(
  Layer.merge(
    toolLayer,
    Layer.mock(Config.Service)({
      get: () => Effect.succeed({ tool_workdir: { extra_roots: ["/tmp"] } }),
    }),
  ),
)

const itWithRestrictedWorkdir = testEffect(
  Layer.merge(
    toolLayer,
    Layer.mock(Config.Service)({
      get: () => Effect.succeed({ tool_workdir: { extra_roots: [] } }),
    }),
  ),
)

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

function makeCtx() {
  const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  const recording: Tool.Context = {
    ...ctx,
    ask: (req) =>
      Effect.sync(() => {
        requests.push(req)
      }),
  }
  return { requests, ctx: recording }
}

describe("tool.git classify", () => {
  const cases: Array<[string[], Partial<ReturnType<typeof classify>>]> = [
    [["status"], { verb: "read", network: false, subcommand: "status" }],
    [["log", "--oneline"], { verb: "read", network: false }],
    [["diff", "--stat"], { verb: "read", network: false }],
    [["show"], { verb: "read", network: false }],
    [["rev-parse", "HEAD"], { verb: "read", network: false }],
    [["ls-files"], { verb: "read", network: false }],
    [["blame", "x.ts"], { verb: "read", network: false }],
    [["commit", "-m", "msg"], { verb: "modify", network: false, subcommand: "commit" }],
    [["add", "."], { verb: "modify", network: false }],
    [["checkout", "-b", "feature"], { verb: "modify", network: false }],
    [["merge", "main"], { verb: "modify", network: false }],
    [["reset", "--hard"], { verb: "modify", network: false }],
    [["init"], { verb: "create", network: false }],
    [["rm", "x.ts"], { verb: "delete", network: false, subcommand: "rm" }],
    [["push", "origin", "main"], { verb: "modify", network: true, subcommand: "push" }],
    [["pull"], { verb: "modify", network: true }],
    [["fetch", "origin"], { verb: "modify", network: true }],
    [["clone", "https://x/y.git"], { verb: "create", network: true, subcommand: "clone" }],
    // context-sensitive
    [["branch"], { verb: "read", network: false }],
    [["branch", "-l"], { verb: "read", network: false }],
    [["branch", "--list"], { verb: "read", network: false }],
    [["branch", "--show-current"], { verb: "read", network: false }],
    [["branch", "feature"], { verb: "modify", network: false }],
    [["branch", "-d", "feature"], { verb: "delete", network: false }],
    [["branch", "-D", "feature"], { verb: "delete", network: false }],
    [["tag"], { verb: "read", network: false }],
    [["tag", "-l"], { verb: "read", network: false }],
    [["tag", "v1.0"], { verb: "modify", network: false }],
    [["tag", "-d", "v1.0"], { verb: "delete", network: false }],
    [["remote", "-v"], { verb: "read", network: false }],
    [["remote", "add", "origin", "url"], { verb: "modify", network: true }],
    [["remote", "set-url", "origin", "url"], { verb: "modify", network: true }],
    [["remote", "remove", "origin"], { verb: "delete", network: false }],
    [["config", "--get", "user.name"], { verb: "read", network: false }],
    [["config", "--list"], { verb: "read", network: false }],
    [["config", "user.name", "Bob"], { verb: "modify", network: false }],
    [["config", "--unset", "user.name"], { verb: "delete", network: false }],
    [["worktree", "list"], { verb: "read", network: false }],
    [["worktree", "add", "../other"], { verb: "modify", network: false }],
    [["stash"], { verb: "modify", network: false }],
    [["stash", "drop"], { verb: "delete", network: false }],
    [["stash", "list"], { verb: "read", network: false }],
  ]

  for (const [args, expected] of cases) {
    it.effect(`classifies git ${args.join(" ")}`, () =>
      Effect.sync(() => {
        expect(classify(args)).toMatchObject(expected)
      }),
    )
  }

  it.effect("flags an unknown subcommand conservatively", () =>
    Effect.sync(() => {
      expect(classify(["frobnicate", "--force"])).toEqual({
        verb: "modify",
        resource: "repo",
        network: false,
        subcommand: "frobnicate",
        unknown: true,
      })
    }),
  )

  it.effect("threads the resource through", () =>
    Effect.sync(() => {
      expect(classify(["status"], "myrepo").resource).toBe("myrepo")
    }),
  )

  // global-option skipping + specific classification fixes
  it.effect("skips leading global options to find the real subcommand", () =>
    Effect.sync(() => {
      expect(classify(["-C", "/tmp", "status"])).toMatchObject({ verb: "read", subcommand: "status" })
      expect(classify(["--git-dir=/x/.git", "log"])).toMatchObject({ verb: "read", subcommand: "log" })
      expect(classify(["-p", "--no-pager", "diff", "--stat"])).toMatchObject({ verb: "read", subcommand: "diff" })
    }),
  )

  it.effect("push --delete / -d classifies as delete + network", () =>
    Effect.sync(() => {
      expect(classify(["push", "--delete", "origin", "x"])).toMatchObject({
        verb: "delete",
        network: true,
        subcommand: "push",
      })
      expect(classify(["push", "-d", "origin", "x"])).toMatchObject({ verb: "delete", network: true })
      expect(classify(["push", "origin", "main"])).toMatchObject({ verb: "modify", network: true })
    }),
  )

  it.effect("clean with -f/-fd/-x/--force classifies as delete", () =>
    Effect.sync(() => {
      expect(classify(["clean", "-fd"])).toMatchObject({ verb: "delete", subcommand: "clean" })
      expect(classify(["clean", "-f"])).toMatchObject({ verb: "delete" })
      expect(classify(["clean", "-x", "-f"])).toMatchObject({ verb: "delete" })
      expect(classify(["clean", "--force"])).toMatchObject({ verb: "delete" })
      // a dry-run clean (no force) does not delete
      expect(classify(["clean", "-n"])).toMatchObject({ verb: "modify" })
    }),
  )

  it.effect("flags dangerous globals in the classification", () =>
    Effect.sync(() => {
      expect(classify(["-c", "x=y", "log"])).toMatchObject({ dangerous: true, subcommand: "log" })
      expect(classify(["--exec-path=/tmp", "status"]).dangerous).toBe(true)
      expect(classify(["filter-branch"]).dangerous).toBe(true)
      // a benign command is not flagged
      expect(classify(["status"]).dangerous).toBeUndefined()
    }),
  )
})

describe("tool.git deny-list", () => {
  const rejected: Array<[string[], string]> = [
    [["-c", "core.pager=sh -c evil", "log"], "-c"],
    [["-c", "alias.x=!sh", "x"], "-c"],
    [["--config-env=core.pager=EVIL", "log"], "--config-env=core.pager=EVIL"],
    [["--upload-pack=evil", "fetch"], "--upload-pack=evil"],
    [["--upload-pack", "evil", "fetch"], "--upload-pack"],
    [["--receive-pack=evil", "push"], "--receive-pack=evil"],
    [["--exec-path=/tmp", "status"], "--exec-path=/tmp"],
    [["--exec-path", "status"], "--exec-path"],
    [["filter-branch"], "filter-branch"],
    [["-C", "/x", "filter-branch", "--tree-filter", "rm -rf x"], "filter-branch"],
  ]

  for (const [args, offending] of rejected) {
    it.effect(`dangerousArgv detects ${args.join(" ")}`, () =>
      Effect.sync(() => {
        expect(dangerousArgv(args)).toBe(offending)
        expect(() => validateArgv(args)).toThrow("is not permitted (command-execution vector)")
      }),
    )
  }

  it.effect("permits ordinary argv", () =>
    Effect.sync(() => {
      expect(dangerousArgv(["status"])).toBeUndefined()
      expect(dangerousArgv(["commit", "-m", "msg"])).toBeUndefined()
      expect(dangerousArgv(["switch", "-c", "feature/foo"])).toBeUndefined()
      expect(dangerousArgv(["switch", "--create", "feature/foo"])).toBeUndefined()
      expect(() => validateArgv(["switch", "-c", "feature/foo"])).not.toThrow()
      expect(() => validateArgv(["log", "--oneline"])).not.toThrow()
    }),
  )

  it.effect("rejects pre-subcommand -c config injection", () =>
    Effect.sync(() => {
      expect(dangerousArgv(["-c", "core.pager=x", "status"])).toBe("-c")
      expect(() => validateArgv(["-c", "core.pager=x", "status"])).toThrow(
        "is not permitted (command-execution vector)",
      )
    }),
  )
})

describe("tool.git behavioral", () => {
  it.instance(
    "rejects a command-execution vector BEFORE running git",
    () =>
      Effect.gen(function* () {
        const info = yield* GitTool
        const tool = yield* info.init()
        // A recording ctx proves the tool never even reaches the permission ask.
        const rec = makeCtx()
        const exit = yield* tool.execute({ args: ["-c", "core.pager=sh -c evil", "log"] }, rec.ctx).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const err = Cause.squash(exit.cause)
          expect(err instanceof Error ? err.message : String(err)).toContain(
            "is not permitted (command-execution vector)",
          )
        }
        expect(rec.requests.length).toBe(0)
      }),
    { git: true },
  )

  it.instance(
    "runs git status and carries a read classification",
    () =>
      Effect.gen(function* () {
        const info = yield* GitTool
        const tool = yield* info.init()
        const result = yield* tool.execute({ args: ["status"] }, ctx)
        expect(result.metadata.exit).toBe(0)
        expect(result.metadata.classification).toMatchObject({
          verb: "read",
          network: false,
          subcommand: "status",
        })
      }),
    { git: true },
  )

  it.instance(
    "runs git in a given workdir",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() => Bun.$`mkdir -p ${path.join(test.directory, "nested")}`.quiet())

        const info = yield* GitTool
        const tool = yield* info.init()
        const result = yield* tool.execute({ args: ["rev-parse", "--show-prefix"], workdir: "nested" }, ctx)
        expect(result.metadata.exit).toBe(0)
        expect(result.metadata.stdout).toBe("nested/\n")
        expect(result.metadata.classification).toMatchObject({
          verb: "read",
          resource: `${path.basename(test.directory)}:nested`,
          subcommand: "rev-parse",
        })
      }),
    { git: true },
  )

  it.instance(
    "allows an external workdir by default and requests external directory permission",
    () =>
      Effect.gen(function* () {
        const outside = yield* tmpdirScoped({ git: true })
        const info = yield* GitTool
        const tool = yield* info.init()
        const rec = makeCtx()
        const result = yield* tool.execute({ args: ["status"], workdir: outside }, rec.ctx)
        expect(result.metadata.exit).toBe(0)
        expect(rec.requests[0]).toMatchObject({
          permission: "external_directory",
          patterns: [path.join(outside, "*")],
        })
      }),
    { git: true },
  )

  it.instance(
    "external directory denial prevents command execution",
    () =>
      Effect.gen(function* () {
        const outside = yield* tmpdirScoped()
        const info = yield* GitTool
        const tool = yield* info.init()
        const requests: string[] = []
        const denied: Tool.Context = {
          ...ctx,
          ask: (req) => {
            requests.push(req.permission)
            return req.permission === "external_directory"
              ? Effect.die(new Error("external_directory denied"))
              : Effect.void
          },
        }
        const exit = yield* tool.execute({ args: ["init"], workdir: outside }, denied).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(String(Cause.squash(exit.cause))).toContain("external_directory denied")
        }
        expect(requests).toEqual(["external_directory"])
        expect(yield* Effect.promise(() => Bun.file(path.join(outside, ".git", "HEAD")).exists())).toBe(false)
      }),
    { git: true },
  )

  itWithRestrictedWorkdir.instance(
    "explicit empty roots reject an external workdir before permission or execution",
    () =>
      Effect.gen(function* () {
        const outside = yield* tmpdirScoped()
        const info = yield* GitTool
        const tool = yield* info.init()
        const rec = makeCtx()
        const exit = yield* tool.execute({ args: ["init"], workdir: outside }, rec.ctx).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(String(Cause.squash(exit.cause))).toContain("resolves outside the workspace root")
        }
        expect(rec.requests).toEqual([])
        expect(yield* Effect.promise(() => Bun.file(path.join(outside, ".git", "HEAD")).exists())).toBe(false)
      }),
    { git: true },
  )

  itWithWorkdirConfig.instance(
    "allows an absolute workdir in configured extra roots",
    () =>
      Effect.gen(function* () {
        const outside = yield* tmpdirScoped({ git: true })
        const info = yield* GitTool
        const tool = yield* info.init()
        const rec = makeCtx()
        const result = yield* tool.execute({ args: ["status"], workdir: outside }, rec.ctx)
        expect(result.metadata.exit).toBe(0)
        expect(result.metadata.classification).toMatchObject({ verb: "read", subcommand: "status" })
        expect(rec.requests[0]?.permission).toBe("external_directory")
        expect(rec.requests.some((r) => (r.metadata as { workdir?: string } | undefined)?.workdir === outside)).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "runs git add + commit and carries modify classifications",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() => Bun.write(`${test.directory}/file.txt`, "hello\n"))

        const info = yield* GitTool
        const tool = yield* info.init()

        const add = yield* tool.execute({ args: ["add", "."] }, ctx)
        expect(add.metadata.exit).toBe(0)
        expect(add.metadata.classification).toMatchObject({ verb: "modify", network: false, subcommand: "add" })

        const commit = yield* tool.execute({ args: ["commit", "-m", "add file"] }, ctx)
        expect(commit.metadata.exit).toBe(0)
        expect(commit.metadata.classification).toMatchObject({ verb: "modify", network: false, subcommand: "commit" })
      }),
    { git: true },
  )

  it.instance(
    "resource resolves to the repo directory basename",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const info = yield* GitTool
        const tool = yield* info.init()
        const result = yield* tool.execute({ args: ["status"] }, ctx)
        const classification = result.metadata.classification as ReturnType<typeof classify>
        // best-effort: basename of the worktree top-level
        expect(classification.resource).toBe(path.basename(test.directory))
      }),
    { git: true },
  )

  it.instance(
    "gates a read subcommand with permission=read and a modify with edit",
    () =>
      Effect.gen(function* () {
        const info = yield* GitTool
        const tool = yield* info.init()

        const readCtx = makeCtx()
        yield* tool.execute({ args: ["status"] }, readCtx.ctx)
        expect(readCtx.requests.some((r) => r.permission === "read")).toBe(true)

        const editCtx = makeCtx()
        yield* tool.execute({ args: ["add", "."] }, editCtx.ctx)
        expect(editCtx.requests.some((r) => r.permission === "edit")).toBe(true)
      }),
    { git: true },
  )
})
