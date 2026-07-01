import { describe, expect } from "bun:test"
import path from "path"
import fs from "node:fs/promises"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../../src/agent/agent"
import { LsTool } from "../../../src/tool/linux/ls"
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
  const recording: Tool.Context = {
    ...ctx,
    ask: (req) =>
      Effect.sync(() => {
        requests.push(req)
      }),
  }
  return { requests, ctx: recording }
}

describe("tool.linux.ls", () => {
  it.instance("lists directory contents", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "alpha.txt"), "a\n"))
      yield* Effect.promise(() => Bun.write(path.join(test.directory, ".hidden.txt"), "h\n"))

      const tool = yield* (yield* LsTool).init()
      const result = yield* tool.execute({ path: ".", all: true }, ctx)
      expect(result.metadata.exit).toBe(0)
      expect(result.output).toContain("alpha.txt")
      expect(result.output).toContain(".hidden.txt")
    }),
  )

  it.instance("inserts -- before the path operand", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "-dash-dir")
      yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
      yield* Effect.promise(() => Bun.write(path.join(dir, "file.txt"), "x\n"))

      const tool = yield* (yield* LsTool).init()
      const result = yield* tool.execute({ path: "-dash-dir" }, ctx)
      const args = result.metadata.args as string[]
      const idx = args.indexOf("--")
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(args[idx + 1]).toBe(dir)
    }),
  )

  it.instance("gates external directories before read ask", () =>
    Effect.gen(function* () {
      const outside = yield* tmpdirScoped()
      yield* Effect.promise(() => Bun.write(path.join(outside, "x.txt"), "x\n"))
      const rec = makeCtx()
      const tool = yield* (yield* LsTool).init()
      yield* tool.execute({ path: outside }, rec.ctx)

      const externalIndex = rec.requests.findIndex((req) => req.permission === "external_directory")
      const readIndex = rec.requests.findIndex((req) => req.permission === "read")
      expect(externalIndex).toBeGreaterThanOrEqual(0)
      expect(readIndex).toBeGreaterThanOrEqual(0)
      expect(externalIndex).toBeLessThan(readIndex)
    }),
  )
})
