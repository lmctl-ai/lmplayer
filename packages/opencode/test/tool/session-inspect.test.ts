import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "../../src/session/schema"
import { SessionInspectTool } from "../../src/tool/session-inspect"
import { Truncate } from "@/tool/truncate"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { testEffect } from "../lib/effect"
import type * as Tool from "../../src/tool/tool"

const toolLayer = () =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Session.node,
      SessionProjector.node,
      Truncate.node,
      Database.node,
      RuntimeFlags.node,
    ]),
  )

const it = testEffect(toolLayer())

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

describe("tool.session_inspect", () => {
  it.instance("list mode returns empty output when no sessions exist", () =>
    Effect.gen(function* () {
      const info = yield* SessionInspectTool
      const tool = yield* info.init()
      const result = yield* tool.execute({ mode: "list" }, ctx)
      expect(result.metadata.mode).toBe("list")
      expect(result.metadata.count).toBe(0)
      expect(result.output).toBe("(no sessions)")
    }),
  )

  it.instance("list mode returns sessions after creation", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* session.create({ title: "Test Session Alpha" })

      const info = yield* SessionInspectTool
      const tool = yield* info.init()
      const result = yield* tool.execute({ mode: "list" }, ctx)

      expect(result.metadata.mode).toBe("list")
      expect(result.metadata.count).toBeGreaterThan(0)
      expect(result.output).toContain(created.id)
      expect(result.output).toContain("Test Session Alpha")
    }),
  )

  it.instance("list mode respects limit parameter", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      yield* session.create({ title: "Session One" })
      yield* session.create({ title: "Session Two" })
      yield* session.create({ title: "Session Three" })

      const info = yield* SessionInspectTool
      const tool = yield* info.init()
      const result = yield* tool.execute({ mode: "list", limit: 2 }, ctx)

      expect(result.metadata.mode).toBe("list")
      expect(result.metadata.count).toBe(2)
    }),
  )

  it.instance("tail mode returns empty output for session with no messages", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* session.create({ title: "Empty Session" })

      const info = yield* SessionInspectTool
      const tool = yield* info.init()
      const result = yield* tool.execute({ mode: "tail", sessionID: created.id }, ctx)

      expect(result.metadata.mode).toBe("tail")
      expect(result.metadata.count).toBe(0)
      expect(result.output).toBe("(no messages)")
    }),
  )

  it.instance("tail mode returns not-found message for unknown session ID", () =>
    Effect.gen(function* () {
      const info = yield* SessionInspectTool
      const tool = yield* info.init()
      const result = yield* tool.execute({ mode: "tail", sessionID: "ses_doesnotexist" }, ctx)

      expect(result.metadata.mode).toBe("tail")
      expect(result.metadata.count).toBe(0)
      expect(result.output).toContain("not found")
    }),
  )

  it.instance("tail mode without sessionID returns error output", () =>
    Effect.gen(function* () {
      const info = yield* SessionInspectTool
      const tool = yield* info.init()
      const result = yield* tool.execute({ mode: "tail" }, ctx)

      expect(result.metadata.mode).toBe("tail")
      expect(result.metadata.count).toBe(0)
      expect(result.output).toContain("sessionID is required")
    }),
  )

  it.instance("tail mode returns messages when session has content", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* session.create({ title: "Session With Messages" })

      yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: created.id,
        agent: "build",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
        time: { created: Date.now() },
      })

      const info = yield* SessionInspectTool
      const tool = yield* info.init()
      const result = yield* tool.execute({ mode: "tail", sessionID: created.id }, ctx)

      expect(result.metadata.mode).toBe("tail")
      expect(result.metadata.count).toBe(1)
      expect(result.output).toContain("user:")
    }),
  )
})
