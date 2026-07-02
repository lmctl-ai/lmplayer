import { describe, expect, test } from "bun:test"
import { createSessionHealth, formatSessionHealth, type SessionMessage } from "@/cli/cmd/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"

type TextPart = Extract<SessionMessage["parts"][number], { type: "text" }>
type StepFinishPart = Extract<SessionMessage["parts"][number], { type: "step-finish" }>

function textPart(messageID: string, text: string): TextPart {
  return {
    id: `prt-text-${messageID}`,
    sessionID: "ses_health",
    messageID,
    type: "text",
    text,
  }
}

function stepFinishPart(messageID: string): StepFinishPart {
  return {
    id: `prt-finish-${messageID}`,
    sessionID: "ses_health",
    messageID,
    type: "step-finish",
    reason: "stop",
    cost: 0.01,
    tokens: {
      total: 60,
      input: 40,
      output: 15,
      reasoning: 5,
      cache: {
        read: 8,
        write: 2,
      },
    },
  }
}

function userMessage(id: string, created: number, parts: SessionMessage["parts"]): SessionMessage {
  return {
    info: {
      id,
      sessionID: "ses_health",
      role: "user",
      time: {
        created,
      },
      agent: "build",
      model: {
        providerID: "test",
        modelID: "test",
      },
    },
    parts,
  }
}

function assistantMessage(id: string, created: number, parts: SessionMessage["parts"]): SessionMessage {
  return {
    info: {
      id,
      sessionID: "ses_health",
      role: "assistant",
      time: {
        created,
      },
      parentID: "msg-user-1",
      modelID: "model-a",
      providerID: "provider-a",
      mode: "chat",
      agent: "build",
      path: {
        cwd: "/tmp/project",
        root: "/tmp/project",
      },
      cost: 0.01,
      tokens: {
        total: 1,
        input: 1,
        output: 0,
        reasoning: 0,
        cache: {
          read: 0,
          write: 0,
        },
      },
    },
    parts,
  }
}

describe("session health", () => {
  test("reports context health from projected text, tokens, and model limit", () => {
    const health = createSessionHealth(
      "ses_health",
      [
        userMessage("msg-user-1", 1_000, [textPart("msg-user-1", "hello")]),
        assistantMessage("msg-assistant-1", 2_000, [textPart("msg-assistant-1", "é"), stepFinishPart("msg-assistant-1")]),
      ],
      {
        [ProviderV2.ID.make("provider-a")]: {
          models: {
            [ModelV2.ID.make("model-a")]: {
              limit: {
                context: 200,
              },
            },
          },
        },
      },
    )

    expect(health.messageCount).toBe(2)
    expect(health.text).toEqual({ chars: 6, bytes: 7 })
    expect(health.tokens).toMatchObject({ total: 60, input: 40, output: 15, reasoning: 5 })
    expect(health.context).toEqual({ used: 60, limit: 200, limitSource: "model", percentUsed: 30, headroom: 140 })
    expect(health.model).toEqual({ providerID: "provider-a", modelID: "model-a" })
    expect(health.state).toEqual({ hasMessages: true, firstMessageAt: 1_000, lastMessageAt: 2_000 })
    expect(formatSessionHealth(health)).toContain("Context: 60 / 200 tokens (30% used, 140 headroom, model limit)")
  })
})
