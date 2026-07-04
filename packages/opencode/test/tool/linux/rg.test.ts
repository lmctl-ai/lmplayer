import { describe, expect } from "bun:test"
import path from "path"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Cause, Exit } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../../src/agent/agent"
import { Permission } from "../../../src/permission"
import { RgTool, classify, dangerousArgv, validateArgv } from "../../../src/tool/linux/rg"
import { SessionID, MessageID } from "../../../src/session/schema"
import { TestInstance, tmpdirScoped } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import type { Tool } from "@/tool/tool"

const toolLayer = LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node, FSUtil.node, Truncate.node, Agent.node]))

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
  const recording = {
    ...ctx,
    ask: (req) =>
      Effect.sync(() => {
        requests.push(req)
      }),
  } as Tool.Context
  return { requests, ctx: recording }
}

function securedCtx(ruleset: PermissionV1.Ruleset) {
  const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  const recording: Tool.Context = {
    ...ctx,
    agent: "secured",
    ask: (req) =>
      Effect.gen(function* () {
        requests.push(req)
        if (req.patterns.some((pattern) => Permission.evaluate(req.permission, pattern, ruleset).action === "deny")) {
          return yield* Effect.die(new PermissionV1.DeniedError({ ruleset }))
        }
      }),
  }
  return { requests, ctx: recording }
}

describe("tool.rg classify", () => {
  it.effect("classifies rg as filesystem read", () =>
    Effect.sync(() => {
      expect(classify(["needle", "."])).toEqual({ verb: "read", resource: "filesystem", network: false })
    }),
  )

  it.effect("flags denied preprocessor/archive options", () =>
    Effect.sync(() => {
      expect(classify(["--pre", "sh", "needle"])).toEqual({
        verb: "read",
        resource: "filesystem",
        network: false,
        dangerous: true,
      })
      expect(classify(["--search-zip", "needle"]).dangerous).toBe(true)
    }),
  )
})

describe("tool.rg deny-list", () => {
  it.effect("rejects preprocessors and archive search", () =>
    Effect.sync(() => {
      for (const token of ["--pre", "--pre=sh", "--pre-glob", "--pre-glob=*.md", "--search-zip"]) {
        expect(dangerousArgv([token, "needle"])).toBe(token)
        expect(() => validateArgv([token, "needle"])).toThrow(
          "is not permitted (preprocessor, archive, or outside-root pattern file)",
        )
      }
    }),
  )

  it.live("rejects -f/--file pattern files outside the root", () =>
    Effect.gen(function* () {
      const outside = yield* tmpdirScoped()
      const root = yield* tmpdirScoped()
      const pattern = path.join(outside, "pattern.txt")
      yield* Effect.promise(() => Bun.write(pattern, "needle\n"))

      expect(dangerousArgv(["-f", pattern, "."], root)).toBe("-f")
      expect(dangerousArgv(["--file", pattern, "."], root)).toBe("--file")
      expect(dangerousArgv([`--file=${pattern}`, "."], root)).toBe(`--file=${pattern}`)
      expect(() => validateArgv(["-f", pattern, "."], root)).toThrow("outside-root pattern file")
    }),
  )
})

describe("tool.rg behavioral", () => {
  it.instance("rejects denied argv before ask/exec", () =>
    Effect.gen(function* () {
      const info = yield* RgTool
      const tool = yield* info.init()
      const rec = makeCtx()
      const exit = yield* tool.execute({ args: ["--pre", "sh", "needle"] }, rec.ctx).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err instanceof Error ? err.message : String(err)).toContain(
          "is not permitted (preprocessor, archive, or outside-root pattern file)",
        )
      }
      expect(rec.requests.length).toBe(0)
    }),
  )

  it.instance("runs rg search and carries a read classification", () =>
    Effect.gen(function* () {
      if (Bun.which("rg") === null) return
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "alpha.txt"), "needle\n"))
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "beta.txt"), "haystack\n"))

      const tool = yield* (yield* RgTool).init()
      const result = yield* tool.execute({ args: ["needle", "."] }, ctx)
      expect(result.metadata.exit).toBe(0)
      expect(result.output).toContain("alpha.txt")
      expect(result.metadata.classification).toEqual({ verb: "read", resource: "filesystem", network: false })
    }),
  )

  it.instance("secured denies sensitive rg operands before execution", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const secured = yield* agents.get("secured")
      if (!secured) throw new Error("secured agent not found")
      const rec = securedCtx(secured.permission)
      const exit = yield* (yield* (yield* RgTool).init()).execute({ args: ["needle", ".env"] }, rec.ctx).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(rec.requests).toHaveLength(1)
      expect(rec.requests[0]?.permission).toBe("read")
      expect(rec.requests[0]?.patterns).toContain(".env")
    }),
  )

  it.instance("secured allows safe rg operands", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const secured = yield* agents.get("secured")
      if (!secured) throw new Error("secured agent not found")
      const rec = securedCtx(secured.permission)
      const tool = yield* (yield* RgTool).init()
      const exit = yield* tool.execute({ args: ["needle", "src"] }, rec.ctx).pipe(Effect.exit)

      expect(rec.requests[0]?.patterns).toContain("rg")
      expect(rec.requests[0]?.patterns).toContain("src")
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(PermissionV1.DeniedError)
      }
    }),
  )
})
