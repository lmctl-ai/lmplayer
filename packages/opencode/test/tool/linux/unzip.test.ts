import { describe, expect } from "bun:test"
import path from "path"
import fs from "node:fs/promises"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Cause, Exit } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../../src/agent/agent"
import { Permission } from "../../../src/permission"
import { UnzipTool, classify, dangerousArgv, validateArgv } from "../../../src/tool/linux/unzip"
import { SessionID, MessageID } from "../../../src/session/schema"
import { TestInstance } from "../../fixture/fixture"
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

describe("tool.unzip classify", () => {
  it.effect("classifies listing/test modes as read", () =>
    Effect.sync(() => {
      expect(classify(["-l", "archive.zip"])).toEqual({ verb: "read", resource: "archive", network: false })
      expect(classify(["-t", "archive.zip"])).toMatchObject({ verb: "read", network: false })
    }),
  )

  it.effect("classifies extraction as modify", () =>
    Effect.sync(() => {
      expect(classify(["archive.zip"])).toEqual({ verb: "modify", resource: "archive", network: false })
    }),
  )

  it.effect("flags absolute and traversal operands", () =>
    Effect.sync(() => {
      expect(classify(["/tmp/archive.zip"]).dangerous).toBe(true)
      expect(classify(["archive.zip", "../secret"]).dangerous).toBe(true)
    }),
  )
})

describe("tool.unzip deny-list", () => {
  it.effect("rejects absolute paths and traversal", () =>
    Effect.sync(() => {
      for (const args of [["/tmp/archive.zip"], ["archive.zip", "../secret"], ["archive.zip", "-d", "../out"]]) {
        expect(dangerousArgv(args)).toBeDefined()
        expect(() => validateArgv(args)).toThrow("is not permitted (absolute path, traversal, or symlink)")
      }
    }),
  )

  it.instance("rejects symlink operands", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "archive.zip"), "not really zip\n"))
      yield* Effect.promise(() => fs.symlink("archive.zip", path.join(test.directory, "link.zip")))

      expect(dangerousArgv(["link.zip"], test.directory)).toBe("link.zip (symlink)")
      expect(() => validateArgv(["link.zip"], test.directory)).toThrow("symlink")
    }),
  )
})

describe("tool.unzip behavioral", () => {
  it.instance("rejects denied argv before ask/exec", () =>
    Effect.gen(function* () {
      const tool = yield* (yield* UnzipTool).init()
      const rec = makeCtx()
      const exit = yield* tool.execute({ args: ["archive.zip", "../secret"] }, rec.ctx).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err instanceof Error ? err.message : String(err)).toContain(
          "is not permitted (absolute path, traversal, or symlink)",
        )
      }
      expect(rec.requests.length).toBe(0)
    }),
  )

  it.instance("runs unzip -v and carries read classification", () =>
    Effect.gen(function* () {
      if (Bun.which("unzip") === null) return
      const tool = yield* (yield* UnzipTool).init()
      const result = yield* tool.execute({ args: ["-v"] }, ctx)
      expect(result.metadata.exit).toBe(0)
      expect(result.output).toContain("UnZip")
      expect(result.metadata.classification).toEqual({ verb: "read", resource: "archive", network: false })
    }),
  )

  it.instance("secured denies sensitive unzip operands before execution", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const secured = yield* agents.get("secured")
      if (!secured) throw new Error("secured agent not found")
      const rec = securedCtx(secured.permission)
      const exit = yield* (yield* (yield* UnzipTool).init()).execute({ args: ["-l", "secrets/archive.zip"] }, rec.ctx).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(rec.requests).toHaveLength(1)
      expect(rec.requests[0]?.permission).toBe("read")
      expect(rec.requests[0]?.patterns).toContain("secrets/archive.zip")
    }),
  )

  it.instance("secured allows safe unzip operands", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const secured = yield* agents.get("secured")
      if (!secured) throw new Error("secured agent not found")
      const rec = securedCtx(secured.permission)
      const exit = yield* (yield* (yield* UnzipTool).init()).execute({ args: ["-l", "archive.zip"] }, rec.ctx).pipe(Effect.exit)

      expect(rec.requests[0]?.patterns).toContain("unzip")
      expect(rec.requests[0]?.patterns).toContain("archive.zip")
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(PermissionV1.DeniedError)
      }
    }),
  )
})
