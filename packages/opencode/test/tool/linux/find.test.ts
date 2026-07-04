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
import { Git } from "@/git"
import { FindTool, classify, dangerousArgv, validateArgv } from "../../../src/tool/linux/find"
import { SessionID, MessageID } from "../../../src/session/schema"
import { TestInstance } from "../../fixture/fixture"
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

describe("tool.find", () => {
  it.effect("classifies find as filesystem read", () =>
    Effect.sync(() => {
      expect(classify([".", "-name", "*.ts"])).toEqual({
        verb: "read",
        resource: "filesystem",
      })
    }),
  )

  it.effect("flags dangerous predicates in classification", () =>
    Effect.sync(() => {
      expect(classify([".", "-delete"])).toEqual({
        verb: "read",
        resource: "filesystem",
        dangerous: true,
      })
    }),
  )

  it.effect("validateArgv rejects command-exec/destructive vectors", () =>
    Effect.sync(() => {
      const rejected = ["-exec", "-delete", "-execdir", "-ok", "-fprintf"]
      for (const token of rejected) {
        expect(dangerousArgv([".", token, "x"])).toBe(token)
        expect(() => validateArgv([".", token, "x"])).toThrow(
          "is not permitted (command-exec or destructive predicate)",
        )
      }
    }),
  )

  it.instance(
    "find lists matching files",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const dir = path.join(test.directory, "src")
        yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
        yield* Effect.promise(() => Bun.write(path.join(dir, "a.ts"), "export {}\n"))
        yield* Effect.promise(() => Bun.write(path.join(dir, "b.js"), "module.exports = {}\n"))

        const info = yield* FindTool
        const tool = yield* info.init()
        const result = yield* tool.execute({ args: [dir, "-name", "*.ts", "-type", "f"] }, ctx)
        expect(result.metadata.exit).toBe(0)
        const output = String(result.output)
        expect(output).toContain(path.join(dir, "a.ts"))
        expect(output).not.toContain(path.join(dir, "b.js"))
      }),
  )

  it.instance(
    "rejects dangerous predicate before ask/exec",
    () =>
      Effect.gen(function* () {
        const info = yield* FindTool
        const tool = yield* info.init()
        const rec = makeCtx()
        const exit = yield* tool.execute({ args: [".", "-delete"] }, rec.ctx).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const err = Cause.squash(exit.cause)
          expect(err instanceof Error ? err.message : String(err)).toContain(
            "is not permitted (command-exec or destructive predicate)",
          )
        }
        expect(rec.requests.length).toBe(0)
      }),
  )

  it.instance(
    "resolves first path token from instance directory for permission gating",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const src = path.join(test.directory, "src")
        yield* Effect.promise(() => fs.mkdir(src, { recursive: true }))
        yield* Effect.promise(() => Bun.write(path.join(src, "a.ts"), "export {}\n"))

        const rec = makeCtx()
        const info = yield* FindTool
        const tool = yield* info.init()
        const result = yield* tool.execute({ args: ["src", "-name", "*.ts"] }, rec.ctx)
        expect(result.metadata.exit).toBe(0)
        expect(rec.requests.some((request) => request.permission === "read")).toBe(true)
        expect(rec.requests.some((request) => request.permission === "external_directory")).toBe(false)
      }),
  )

  it.instance("secured denies sensitive find operands before execution", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const secured = yield* agents.get("secured")
      if (!secured) throw new Error("secured agent not found")
      const rec = securedCtx(secured.permission)
      const exit = yield* (yield* (yield* FindTool).init()).execute({ args: ["secrets", "-type", "f"] }, rec.ctx).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(rec.requests).toHaveLength(1)
      expect(rec.requests[0]?.permission).toBe("read")
      expect(rec.requests[0]?.patterns).toContain("secrets")
    }),
  )

  it.instance("secured allows safe find operands", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const secured = yield* agents.get("secured")
      if (!secured) throw new Error("secured agent not found")
      const rec = securedCtx(secured.permission)
      const exit = yield* (yield* (yield* FindTool).init()).execute({ args: ["src", "-name", "*.ts"] }, rec.ctx).pipe(Effect.exit)

      expect(rec.requests[0]?.patterns).toContain("find")
      expect(rec.requests[0]?.patterns).toContain("src")
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(PermissionV1.DeniedError)
      }
    }),
  )
})
