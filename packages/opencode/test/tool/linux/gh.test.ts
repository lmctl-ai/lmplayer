import { describe, expect } from "bun:test"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Cause, Exit } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../../src/agent/agent"
import { Git } from "@/git"
import { GhTool, classify, validateArgv, dangerousArgv } from "../../../src/tool/linux/gh"
import { SessionID, MessageID } from "../../../src/session/schema"
import { testEffect } from "../../lib/effect"
import type { Tool } from "@/tool/tool"

const toolLayer = LayerNode.compile(
  LayerNode.group([CrossSpawnSpawner.node, FSUtil.node, Truncate.node, Agent.node, Git.node]),
)

const it = testEffect(toolLayer)

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

describe("tool.gh classify", () => {
  it.effect("classifies pr view as read+network", () =>
    Effect.sync(() => {
      expect(classify(["pr", "view"])).toMatchObject({
        verb: "read",
        network: true,
        subcommand: "pr",
      })
    }),
  )

  it.effect("classifies pr create as modify+network", () =>
    Effect.sync(() => {
      expect(classify(["pr", "create"])).toMatchObject({
        verb: "modify",
        network: true,
        subcommand: "pr",
      })
    }),
  )

  it.effect("classifies repo delete as delete+network", () =>
    Effect.sync(() => {
      expect(classify(["repo", "delete"])).toMatchObject({
        verb: "delete",
        network: true,
        subcommand: "repo",
      })
    }),
  )

  it.effect("classifies api as modify+network by default", () =>
    Effect.sync(() => {
      expect(classify(["api", "repos/owner/repo"])).toMatchObject({
        verb: "modify",
        network: true,
        subcommand: "api",
      })
    }),
  )

  it.effect("flags alias and extension as dangerous", () =>
    Effect.sync(() => {
      expect(classify(["alias", "set", "x", "!sh"]).dangerous).toBe(true)
      expect(classify(["extension", "install", "x"]).dangerous).toBe(true)
      expect(classify(["ext", "install", "x"]).dangerous).toBe(true)
    }),
  )

  it.effect("uses repo flag for resource", () =>
    Effect.sync(() => {
      expect(classify(["--repo", "owner/name", "pr", "view"]).resource).toBe("owner/name")
      expect(classify(["-R", "owner/name", "issue", "list"]).resource).toBe("owner/name")
      expect(classify(["--repo=owner/name", "repo", "view"]).resource).toBe("owner/name")
    }),
  )
})

describe("tool.gh deny-list", () => {
  const rejected: Array<[string[], string]> = [
    [["alias", "set", "x", "!sh"], "alias"],
    [["extension", "install", "evil/ext"], "extension"],
    [["ext", "install", "evil/ext"], "ext"],
  ]

  for (const [args, offending] of rejected) {
    it.effect(`dangerousArgv detects ${args.join(" ")}`, () =>
      Effect.sync(() => {
        expect(dangerousArgv(args)).toBe(offending)
        expect(() => validateArgv(args)).toThrow("is not permitted (command-execution vector)")
      }),
    )
  }
})

describe("tool.gh behavioral", () => {
  it.instance(
    "rejects dangerous subcommand BEFORE running gh",
    () =>
      Effect.gen(function* () {
        const info = yield* GhTool
        const tool = yield* info.init()
        const rec = makeCtx()
        const exit = yield* tool.execute({ args: ["alias", "list"] }, rec.ctx).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const err = Cause.squash(exit.cause)
          expect(err instanceof Error ? err.message : String(err)).toContain(
            "is not permitted (command-execution vector)",
          )
        }
        expect(rec.requests.length).toBe(0)
      }),
  )

  it.instance(
    "runs gh --version without auth/network",
    () =>
      Effect.gen(function* () {
        const info = yield* GhTool
        const tool = yield* info.init()
        const result = yield* tool.execute({ args: ["--version"] }, ctx)
        expect(result.metadata.exit).toBe(0)
      }),
  )
})
