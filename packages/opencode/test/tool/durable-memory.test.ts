import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { DurableMemoryTool } from "../../src/tool/durable-memory"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"
import type * as Tool from "../../src/tool/tool"

const toolLayer = () =>
  LayerNode.compile(LayerNode.group([Agent.node, Truncate.node, FSUtil.node, CrossSpawnSpawner.node]))

const it = testEffect(toolLayer())

const createMockCtx = (sessionIDStr: string) => {
  const asks: Array<{ permission: string; patterns: string[]; metadata: any }> = []
  const ctx: Tool.Context = {
    sessionID: SessionID.make(sessionIDStr),
    messageID: MessageID.make("msg_test"),
    callID: "call_test",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (input) =>
      Effect.sync(() => {
        asks.push(input as any)
      }),
  }
  return { ctx, asks }
}

describe("tool.durable_memory", () => {
  it.instance("read mode returns empty notice when session has no durable memory", () =>
    Effect.gen(function* () {
      const { ctx } = createMockCtx("ses_dm_empty_" + Date.now())
      const info = yield* DurableMemoryTool
      const tool = yield* info.init()

      const result = yield* tool.execute({ action: "read" }, ctx)
      expect(result.metadata.action).toBe("read")
      expect(result.metadata.bytes).toBe(0)
      expect(result.output).toContain("no durable memory recorded yet")
    }),
  )

  it.instance("write mode saves content and read mode returns it", () =>
    Effect.gen(function* () {
      const { ctx, asks } = createMockCtx("ses_dm_write_" + Date.now())
      const info = yield* DurableMemoryTool
      const tool = yield* info.init()

      const content = "## Goal\n- Deliver durable memory tool\n\n## Key Decisions\n- Support read/write/append"
      const writeResult = yield* tool.execute({ action: "write", content }, ctx)

      expect(writeResult.metadata.action).toBe("write")
      expect(writeResult.metadata.bytes).toBe(content.length)
      expect(writeResult.output).toContain("Updated durable memory")
      expect(asks.length).toBe(1)
      expect(asks[0].permission).toBe("durable_memory")
      expect(asks[0].patterns).toEqual(["write"])

      // Read back
      const readResult = yield* tool.execute({ action: "read" }, ctx)
      expect(readResult.metadata.action).toBe("read")
      expect(readResult.metadata.bytes).toBe(content.length)
      expect(readResult.output).toBe(content)
      // Read should not have triggered an additional permission ask
      expect(asks.length).toBe(1)
    }),
  )

  it.instance("append mode adds note to existing content with newline separation", () =>
    Effect.gen(function* () {
      const { ctx, asks } = createMockCtx("ses_dm_append_" + Date.now())
      const info = yield* DurableMemoryTool
      const tool = yield* info.init()

      yield* tool.execute({ action: "write", content: "## Goal\n- Initial goal" }, ctx)

      const note = "## Current State\n- Progress milestone achieved"
      const appendResult = yield* tool.execute({ action: "append", content: note }, ctx)

      expect(appendResult.metadata.action).toBe("append")
      expect(appendResult.output).toContain("Appended to durable memory")
      expect(asks.length).toBe(2)
      expect(asks[1].permission).toBe("durable_memory")
      expect(asks[1].patterns).toEqual(["append"])

      const readResult = yield* tool.execute({ action: "read" }, ctx)
      expect(readResult.output).toBe("## Goal\n- Initial goal\n\n## Current State\n- Progress milestone achieved")
    }),
  )

  it.instance("append mode initializes memory when no prior memory exists", () =>
    Effect.gen(function* () {
      const { ctx } = createMockCtx("ses_dm_append_init_" + Date.now())
      const info = yield* DurableMemoryTool
      const tool = yield* info.init()

      const note = "## Goal\n- Starting fresh via append"
      const appendResult = yield* tool.execute({ action: "append", content: note }, ctx)

      expect(appendResult.metadata.action).toBe("append")
      expect(appendResult.output).toContain("Appended to durable memory")

      const readResult = yield* tool.execute({ action: "read" }, ctx)
      expect(readResult.output).toBe(note)
    }),
  )

  it.instance("write fails when content is missing or whitespace-only", () =>
    Effect.gen(function* () {
      const { ctx } = createMockCtx("ses_dm_fail_write_" + Date.now())
      const info = yield* DurableMemoryTool
      const tool = yield* info.init()

      const exit = yield* Effect.exit(tool.execute({ action: "write" }, ctx))
      expect(exit._tag).toBe("Failure")

      const exitWhitespace = yield* Effect.exit(tool.execute({ action: "write", content: "   \n  " }, ctx))
      expect(exitWhitespace._tag).toBe("Failure")
    }),
  )

  it.instance("append fails when content is missing or whitespace-only", () =>
    Effect.gen(function* () {
      const { ctx } = createMockCtx("ses_dm_fail_append_" + Date.now())
      const info = yield* DurableMemoryTool
      const tool = yield* info.init()

      const exit = yield* Effect.exit(tool.execute({ action: "append" }, ctx))
      expect(exit._tag).toBe("Failure")

      const exitWhitespace = yield* Effect.exit(tool.execute({ action: "append", content: "   " }, ctx))
      expect(exitWhitespace._tag).toBe("Failure")
    }),
  )

  it.instance("sessionID parameter allows operating on a different target session", () =>
    Effect.gen(function* () {
      const { ctx } = createMockCtx("ses_dm_caller_" + Date.now())
      const targetSessionID = "ses_dm_target_" + Date.now()
      const info = yield* DurableMemoryTool
      const tool = yield* info.init()

      const content = "## Goal\n- Target session specific memory"
      yield* tool.execute({ action: "write", content, sessionID: targetSessionID }, ctx)

      // Caller session remains empty
      const callerRead = yield* tool.execute({ action: "read" }, ctx)
      expect(callerRead.output).toContain("no durable memory recorded yet")

      // Target session has the memory
      const targetRead = yield* tool.execute({ action: "read", sessionID: targetSessionID }, ctx)
      expect(targetRead.output).toBe(content)
      expect(targetRead.metadata.sessionID).toBe(targetSessionID)
    }),
  )
})
