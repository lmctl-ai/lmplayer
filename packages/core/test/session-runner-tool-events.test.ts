import { expect, test } from "bun:test"
import { Effect, Schema, Stream } from "effect"
import { LLMEvent } from "@opencode-ai/llm"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionV2 } from "@opencode-ai/core/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { createLLMEventPublisher } from "@opencode-ai/core/session/runner/publish-llm-event"

const sessionID = SessionV2.ID.make("ses_tool_event_test")
const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"

const capture = () => {
  const published: Array<{ readonly type: string; readonly data: unknown }> = []
  const events = EventV2.Service.of({
    publish: (definition, data) =>
      Effect.sync(() => {
        const event = { id: EventV2.ID.create(), type: definition.type, data } as EventV2.Payload<typeof definition>
        published.push({
          type: definition.durable
            ? EventV2.versionedType(definition.type, definition.durable.version)
            : definition.type,
          data,
        })
        return event
      }),
    subscribe: () => Stream.empty,
    all: () => Stream.empty,
    durable: () => Stream.empty,
    listen: () => Effect.succeed(Effect.void),
    project: () => Effect.void,
    replay: () => Effect.void,
    replayAll: () => Effect.succeed(undefined),
    remove: () => Effect.void,
    claim: () => Effect.void,
  })
  return {
    published,
    publisher: createLLMEventPublisher(events, {
      sessionID,
      agent: "build",
      model: {
        id: ModelV2.ID.make("model"),
        providerID: ProviderV2.ID.make("provider"),
      },
    }),
  }
}

const call = LLMEvent.toolCall({ id: "call-image", name: "read", input: { path: "pixel.png" } })
const result = LLMEvent.toolResult({
  id: "call-image",
  name: "read",
  result: {
    type: "content",
    value: [
      { type: "text", text: "Image read successfully" },
      { type: "file", uri: `data:image/png;base64,${base64}`, mime: "image/png", name: "pixel.png" },
    ],
  },
  output: {
    structured: { type: "media", mime: "image/png" },
    content: [
      { type: "text", text: "Image read successfully" },
      { type: "file", uri: `data:image/png;base64,${base64}`, mime: "image/png", name: "pixel.png" },
    ],
  },
})

test("local tool success serializes media base64 once and reconstructs from structured content", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(call))
  await Effect.runPromise(publisher.publish(result))

  const success = published.find((event) => event.type === "session.next.tool.success.1")
  expect(success).toBeDefined()
  const serialized = JSON.stringify(success)
  expect(serialized.split(base64)).toHaveLength(2)
  expect(success?.data).not.toHaveProperty("result")

  expect(success?.data).toMatchObject({
    content: [
      { type: "text", text: "Image read successfully" },
      { type: "file", uri: `data:image/png;base64,${base64}`, mime: "image/png" },
    ],
  })
})

test("provider-executed success retains its compatibility result", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(LLMEvent.toolCall({ ...call, providerExecuted: true })))
  await Effect.runPromise(publisher.publish(LLMEvent.toolResult({ ...result, providerExecuted: true })))
  const success = published.find((event) => event.type === "session.next.tool.success.1")
  expect(success?.data).toHaveProperty("result")
})

test("binary failure emits no success event", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(call))
  await Effect.runPromise(
    publisher.publish(
      LLMEvent.toolResult({
        id: call.id,
        name: call.name,
        result: { type: "error", value: "Cannot read binary file" },
      }),
    ),
  )
  expect(published.some((event) => event.type === "session.next.tool.success.1")).toBe(false)
  expect(published.some((event) => event.type === "session.next.tool.failed.1")).toBe(true)
})

test("old success event data containing result still decodes", () => {
  const decoded = Schema.decodeUnknownSync(SessionEvent.Tool.Success.data)({
    sessionID,
    timestamp: Date.now(),
    assistantMessageID: SessionMessage.ID.create(),
    callID: "call-old",
    structured: { type: "media", mime: "image/png" },
    content: [{ type: "file", uri: `data:image/png;base64,${base64}`, mime: "image/png" }],
    result: { type: "content", value: [{ type: "file", uri: `data:image/png;base64,${base64}`, mime: "image/png" }] },
    provider: { executed: false },
  })
  expect(decoded.result).toMatchObject({ type: "content" })
})

test("step finish records settlement without publishing step ended", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(LLMEvent.stepStart({ index: 0 })))
  await Effect.runPromise(publisher.publish(LLMEvent.stepFinish({ index: 0, reason: "stop" })))

  expect(published.some((event) => event.type === "session.next.step.ended.2")).toBe(false)
  expect(publisher.stepSettlement()).toMatchObject({ finish: "stop", cost: 0 })
})

test("step finish calculates write-time cost from model cost rates", async () => {
  const events = EventV2.Service.of({
    publish: (definition, data) => Effect.succeed({ id: EventV2.ID.create(), type: definition.type, data } as any),
    subscribe: () => Stream.empty,
    all: () => Stream.empty,
    durable: () => Stream.empty,
    listen: () => Effect.succeed(Effect.void),
    project: () => Effect.void,
    replay: () => Effect.void,
    replayAll: () => Effect.succeed(undefined),
    remove: () => Effect.void,
    claim: () => Effect.void,
  })

  const publisher = createLLMEventPublisher(events, {
    sessionID,
    agent: "build",
    model: {
      id: ModelV2.ID.make("model"),
      providerID: ProviderV2.ID.make("provider"),
    },
    cost: [
      {
        input: 3.0,
        output: 15.0,
        cache: { read: 0.3, write: 3.75 },
      },
    ],
  })

  await Effect.runPromise(publisher.publish(LLMEvent.stepStart({ index: 0 })))
  await Effect.runPromise(
    publisher.publish(
      LLMEvent.stepFinish({
        index: 0,
        reason: "stop",
        usage: {
          inputTokens: 10_000,
          outputTokens: 2_000,
          reasoningTokens: 500,
          cacheReadInputTokens: 5_000,
          cacheWriteInputTokens: 1_000,
        },
      }),
    ),
  )

  const settlement = publisher.stepSettlement()
  expect(settlement).toBeDefined()
  expect(settlement?.finish).toBe("stop")
  expect(settlement?.tokens).toEqual({
    input: 4_000,
    output: 1_500,
    reasoning: 500,
    cache: { read: 5_000, write: 1_000 },
  })
  // Cost breakdown:
  // input: 4,000 * 3.0 / 1M = 0.012
  // output: 1,500 * 15.0 / 1M = 0.0225
  // reasoning: 500 * 15.0 / 1M = 0.0075
  // cache read: 5,000 * 0.3 / 1M = 0.0015
  // cache write: 1,000 * 3.75 / 1M = 0.00375
  // total = 0.012 + 0.0225 + 0.0075 + 0.0015 + 0.00375 = 0.04725
  expect(settlement?.cost).toBe(0.04725)
})

test("Model.Cost.calculate selects higher tier when context exceeds threshold", () => {
  const costs = [
    {
      input: 3.0,
      output: 15.0,
      cache: { read: 0.3, write: 3.75 },
    },
    {
      tier: { type: "context" as const, size: 200_000 },
      input: 6.0,
      output: 30.0,
      cache: { read: 0.6, write: 7.5 },
    },
  ]

  // Context under 200k (e.g. 50k input): uses base rates
  const underTokens = {
    input: 50_000,
    output: 10_000,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  }
  // 50k * 3 / 1M = 0.15; 10k * 15 / 1M = 0.15 => 0.30
  expect(ModelV2.Cost.calculate(costs, underTokens)).toBe(0.3)

  // Context over 200k (e.g. 250k input): uses 200k tier rates
  const overTokens = {
    input: 250_000,
    output: 10_000,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  }
  // 250k * 6 / 1M = 1.5; 10k * 30 / 1M = 0.3 => 1.80
  expect(ModelV2.Cost.calculate(costs, overTokens)).toBe(1.8)
})
