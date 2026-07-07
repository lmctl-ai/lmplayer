import { describe, expect, test } from "bun:test"
import { createSessionMetrics, type SessionMessage } from "@/cli/cmd/session"

type ToolPart = Extract<SessionMessage["parts"][number], { type: "tool" }>
type TextPart = Extract<SessionMessage["parts"][number], { type: "text" }>
type StepFinishPart = Extract<SessionMessage["parts"][number], { type: "step-finish" }>

function textPart(messageID: string, text: string): TextPart {
  return {
    id: `prt-text-${messageID}`,
    sessionID: "ses_metrics",
    messageID,
    type: "text",
    text,
  }
}

function stepFinishPart(messageID: string, tokens: StepFinishPart["tokens"]): StepFinishPart {
  return {
    id: `prt-finish-${messageID}`,
    sessionID: "ses_metrics",
    messageID,
    type: "step-finish",
    reason: "stop",
    cost: 0,
    tokens,
  }
}

function toolPart(
  messageID: string,
  tool: string,
  input: Record<string, unknown>,
  metadata: Record<string, unknown>,
  timeStart = 1000,
  timeEnd = 1500,
): ToolPart {
  return {
    id: `prt-tool-${messageID}-${tool}`,
    sessionID: "ses_metrics",
    messageID,
    type: "tool",
    callID: `call-${messageID}-${tool}`,
    tool,
    state: {
      status: "completed",
      input,
      output: "ok",
      title: tool,
      metadata,
      time: { start: timeStart, end: timeEnd },
    },
  }
}

function userMessage(id: string, created: number, parts: SessionMessage["parts"]): SessionMessage {
  return {
    info: {
      id,
      sessionID: "ses_metrics",
      role: "user",
      time: { created },
      agent: "build",
      model: { providerID: "test-provider", modelID: "test-model" },
    },
    parts,
  }
}

function assistantMessage(
  id: string,
  created: number,
  completed: number | undefined,
  parts: SessionMessage["parts"],
): SessionMessage {
  return {
    info: {
      id,
      sessionID: "ses_metrics",
      role: "assistant",
      time: completed !== undefined ? { created, completed } : { created },
      parentID: "msg-user-1",
      modelID: "model-x",
      providerID: "provider-x",
      mode: "chat",
      agent: "build",
      path: { cwd: "/tmp/proj", root: "/tmp/proj" },
      cost: 0,
      tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts,
  }
}

const sessionTokens = {
  input: 1000,
  output: 500,
  reasoning: 100,
  cache: { read: 200, write: 100 },
}

const pricing = { input: 1.0, output: 1.0, cache: { read: 0.5, write: 0.5 } }

// cost = (1000*1.0 + 500*1.0 + 100*1.0 + 200*0.5 + 100*0.5) / 1_000_000
//      = (1000 + 500 + 100 + 100 + 50) / 1_000_000 = 1750 / 1_000_000 = 0.00175

const stepTokens = {
  total: 300,
  input: 200,
  output: 80,
  reasoning: 20,
  cache: { read: 50, write: 25 },
}

function makeMessages(): SessionMessage[] {
  return [
    userMessage("msg-u1", 1000, [textPart("msg-u1", "hello")]),
    // Turn 1: created=2000, completed=4000 → duration=2000ms
    // Tool A: start=2100, end=2600 → duration=500ms
    assistantMessage("msg-a1", 2000, 4000, [
      textPart("msg-a1", "response"),
      stepFinishPart("msg-a1", stepTokens),
      toolPart("msg-a1", "bash", { command: "ls" }, {}, 2100, 2600),
      // write with exists=false → created
      toolPart("msg-a1", "write", { filePath: "/tmp/proj/new.ts" }, { exists: false }, 2700, 2900),
      // write with exists=true → modified
      toolPart("msg-a1", "write", { filePath: "/tmp/proj/old.ts" }, { exists: true }, 2900, 3100),
    ]),
    // Turn 2: created=5000, completed=9000 → duration=4000ms
    // Tool B: start=5100, end=6100 → duration=1000ms
    assistantMessage("msg-a2", 5000, 9000, [
      stepFinishPart("msg-a2", stepTokens),
      toolPart("msg-a2", "bash", { command: "pwd" }, {}, 5100, 6100),
      // edit → modified
      toolPart("msg-a2", "edit", { filePath: "/tmp/proj/update.ts" }, {}, 6200, 6400),
      // apply_patch: add/update/delete
      toolPart(
        "msg-a2",
        "apply_patch",
        { patchText: "patch" },
        {
          files: [
            { filePath: "/tmp/proj/added.ts", type: "add" },
            { filePath: "/tmp/proj/changed.ts", type: "update" },
            { filePath: "/tmp/proj/removed.ts", type: "delete" },
          ],
        },
        6500,
        6800,
      ),
      // rm → deleted
      toolPart("msg-a2", "rm", { paths: ["/tmp/proj/gone.ts"] }, {}, 7000, 7200),
    ]),
  ]
}

describe("session metrics", () => {
  test("tokens from session.tokens when provided and non-zero", () => {
    const msgs = makeMessages()
    const metrics = createSessionMetrics("ses_metrics", msgs, {
      session: { tokens: sessionTokens },
      pricing,
    })

    expect(metrics.tokens).toEqual({
      input: 1000,
      output: 500,
      reasoning: 100,
      cache: { read: 200, write: 100 },
      total: 1900,
    })
    expect(metrics.schema).toBe("session-metrics/v1")
    expect(metrics.sessionID).toBe("ses_metrics")
  })

  test("tokens fall back to summed step-finish tokens when session.tokens omitted", () => {
    const msgs = makeMessages()
    const metrics = createSessionMetrics("ses_metrics", msgs)

    // 2 assistant messages each with stepTokens → total input = 200+200 = 400
    expect(metrics.tokens.input).toBe(400)
    expect(metrics.tokens.output).toBe(160)
    expect(metrics.tokens.reasoning).toBe(40)
    expect(metrics.tokens.cache.read).toBe(100)
    expect(metrics.tokens.cache.write).toBe(50)
    expect(metrics.tokens.total).toBe(400 + 160 + 40 + 100 + 50)
  })

  test("tokens fall back when session.tokens is all-zero", () => {
    const msgs = makeMessages()
    const zeroTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    const metrics = createSessionMetrics("ses_metrics", msgs, {
      session: { tokens: zeroTokens },
    })
    // Should fall back to summed report tokens
    expect(metrics.tokens.input).toBe(400)
  })

  test("cost_usd derived correctly from known pricing", () => {
    const msgs = makeMessages()
    const metrics = createSessionMetrics("ses_metrics", msgs, {
      session: { tokens: sessionTokens },
      pricing,
    })

    // (1000*1.0 + 500*1.0 + 100*1.0 + 200*0.5 + 100*0.5) / 1_000_000 = 1750/1e6
    expect(metrics.cost_usd).toBe(0.00175)
    expect(metrics.cost.usd).toBe(0.00175)
    expect(metrics.cost.source).toBe("derived")
    expect(metrics.cost.pricing_available).toBe(true)
  })

  test("cost_usd is 0 and pricing_available=false when pricing omitted", () => {
    const msgs = makeMessages()
    const metrics = createSessionMetrics("ses_metrics", msgs, {
      session: { tokens: sessionTokens },
    })

    expect(metrics.cost_usd).toBe(0)
    expect(metrics.cost.usd).toBe(0)
    expect(metrics.cost.source).toBe("unavailable")
    expect(metrics.cost.pricing_available).toBe(false)
  })

  test("messages and turns count", () => {
    const msgs = makeMessages()
    const metrics = createSessionMetrics("ses_metrics", msgs)

    // 1 user + 2 assistant = 3 messages; 2 assistant turns
    expect(metrics.messages).toBe(3)
    expect(metrics.turns).toBe(2)
  })

  test("latency_ms: total, per_turn_p50, per_turn_max, tool_total, tool_p50, tool_max, thinking_total", () => {
    const msgs = makeMessages()
    const metrics = createSessionMetrics("ses_metrics", msgs)

    // Turn durations: [2000, 4000] → total=6000, p50=sorted[floor(1/2)]=sorted[0]=2000, max=4000
    expect(metrics.latency_ms.total).toBe(6000)
    expect(metrics.latency_ms.per_turn_p50).toBe(2000)
    expect(metrics.latency_ms.per_turn_max).toBe(4000)

    // Tool durations: bash(500), write(200), write(200), bash(1000), edit(200), apply_patch(300), rm(200)
    // = [500, 200, 200, 1000, 200, 300, 200] → total=2600
    // sorted: [200, 200, 200, 200, 300, 500, 1000]
    // p50 index = floor((7-1)/2) = 3 → 200
    // max = 1000
    expect(metrics.latency_ms.tool_total).toBe(2600)
    expect(metrics.latency_ms.tool_p50).toBe(200)
    expect(metrics.latency_ms.tool_max).toBe(1000)

    // thinking_total = max(0, 6000 - 2600) = 3400
    expect(metrics.latency_ms.thinking_total).toBe(3400)
  })

  test("tools counts all tool parts", () => {
    const msgs = makeMessages()
    const metrics = createSessionMetrics("ses_metrics", msgs)

    expect(metrics.tools["bash"]).toBe(2)
    expect(metrics.tools["write"]).toBe(2)
    expect(metrics.tools["edit"]).toBe(1)
    expect(metrics.tools["apply_patch"]).toBe(1)
    expect(metrics.tools["rm"]).toBe(1)
  })

  test("files.created for write with exists=false", () => {
    const msgs = makeMessages()
    const metrics = createSessionMetrics("ses_metrics", msgs)

    expect(metrics.files.created).toContain("/tmp/proj/new.ts")
    expect(metrics.files.modified).not.toContain("/tmp/proj/new.ts")
  })

  test("files.modified for write with exists=true", () => {
    const msgs = makeMessages()
    const metrics = createSessionMetrics("ses_metrics", msgs)

    expect(metrics.files.modified).toContain("/tmp/proj/old.ts")
    expect(metrics.files.created).not.toContain("/tmp/proj/old.ts")
  })

  test("files.modified for edit", () => {
    const msgs = makeMessages()
    const metrics = createSessionMetrics("ses_metrics", msgs)

    expect(metrics.files.modified).toContain("/tmp/proj/update.ts")
    expect(metrics.files.created).not.toContain("/tmp/proj/update.ts")
  })

  test("files apply_patch: add→created, update→modified, delete→deleted", () => {
    const msgs = makeMessages()
    const metrics = createSessionMetrics("ses_metrics", msgs)

    expect(metrics.files.created).toContain("/tmp/proj/added.ts")
    expect(metrics.files.modified).toContain("/tmp/proj/changed.ts")
    expect(metrics.files.deleted).toContain("/tmp/proj/removed.ts")
  })

  test("files.deleted for rm", () => {
    const msgs = makeMessages()
    const metrics = createSessionMetrics("ses_metrics", msgs)

    expect(metrics.files.deleted).toContain("/tmp/proj/gone.ts")
    expect(metrics.files.created).not.toContain("/tmp/proj/gone.ts")
    expect(metrics.files.modified).not.toContain("/tmp/proj/gone.ts")
  })

  test("files all arrays are sorted and created does not overlap modified", () => {
    const msgs = makeMessages()
    const metrics = createSessionMetrics("ses_metrics", msgs)

    const createdSet = new Set(metrics.files.created)
    const modifiedSet = new Set(metrics.files.modified)

    // No overlap between created and modified
    for (const p of metrics.files.created) {
      expect(modifiedSet.has(p)).toBe(false)
    }

    // created and modified are sorted
    expect(metrics.files.created).toEqual([...metrics.files.created].sort())
    expect(metrics.files.modified).toEqual([...metrics.files.modified].sort())
    expect(metrics.files.deleted).toEqual([...metrics.files.deleted].sort())
    expect(metrics.files.touched).toEqual([...metrics.files.touched].sort())

    // touched contains all paths
    const all = [...createdSet, ...modifiedSet, ...metrics.files.deleted]
    for (const p of all) {
      expect(metrics.files.touched).toContain(p)
    }
  })

  test("model from session.model when provided", () => {
    const msgs = makeMessages()
    const metrics = createSessionMetrics("ses_metrics", msgs, {
      session: { model: { id: "claude-sonnet-5", providerID: "github-copilot" } },
    })

    expect(metrics.model).toBe("github-copilot/claude-sonnet-5")
    expect(metrics.providerID).toBe("github-copilot")
    expect(metrics.modelID).toBe("claude-sonnet-5")
  })

  test("model falls back to latest assistant message when session.model absent", () => {
    const msgs = makeMessages()
    const metrics = createSessionMetrics("ses_metrics", msgs)

    // latestModel returns the last assistant message: provider-x/model-x
    expect(metrics.model).toBe("provider-x/model-x")
    expect(metrics.providerID).toBe("provider-x")
    expect(metrics.modelID).toBe("model-x")
  })

  test("model is null when no session model and no assistant messages", () => {
    const metrics = createSessionMetrics("ses_empty", [])
    expect(metrics.model).toBeNull()
    expect(metrics.providerID).toBeNull()
    expect(metrics.modelID).toBeNull()
  })

  test("latency_ms is all zeros for empty messages", () => {
    const metrics = createSessionMetrics("ses_empty", [])
    expect(metrics.latency_ms.total).toBe(0)
    expect(metrics.latency_ms.per_turn_p50).toBe(0)
    expect(metrics.latency_ms.per_turn_max).toBe(0)
    expect(metrics.latency_ms.tool_total).toBe(0)
    expect(metrics.latency_ms.tool_p50).toBe(0)
    expect(metrics.latency_ms.tool_max).toBe(0)
    expect(metrics.latency_ms.thinking_total).toBe(0)
  })

  test("p50 lower-median: single value returns that value", () => {
    const msgs = [
      userMessage("msg-u1", 1000, []),
      assistantMessage("msg-a1", 2000, 5000, []),
    ]
    const metrics = createSessionMetrics("ses_p50", msgs)
    // single turn duration = 3000
    expect(metrics.latency_ms.per_turn_p50).toBe(3000)
    expect(metrics.latency_ms.per_turn_max).toBe(3000)
  })

  test("mv tool: source path → deleted, dest path → created", () => {
    const msgs: SessionMessage[] = [
      userMessage("msg-u1", 1000, []),
      assistantMessage("msg-a1", 2000, 3000, [
        toolPart("msg-a1", "mv", { source: "/tmp/proj/old-name.ts", dest: "/tmp/proj/new-name.ts" }, {}),
      ]),
    ]
    const metrics = createSessionMetrics("ses_mv", msgs)

    expect(metrics.files.deleted).toContain("/tmp/proj/old-name.ts")
    expect(metrics.files.created).toContain("/tmp/proj/new-name.ts")
    expect(metrics.files.modified).not.toContain("/tmp/proj/old-name.ts")
    expect(metrics.files.modified).not.toContain("/tmp/proj/new-name.ts")
    // both paths appear in touched
    expect(metrics.files.touched).toContain("/tmp/proj/old-name.ts")
    expect(metrics.files.touched).toContain("/tmp/proj/new-name.ts")
  })

  test("apply_patch move: source filePath → deleted, movePath → created", () => {
    const msgs: SessionMessage[] = [
      userMessage("msg-u1", 1000, []),
      assistantMessage("msg-a1", 2000, 3000, [
        toolPart(
          "msg-a1",
          "apply_patch",
          { patchText: "patch" },
          {
            files: [{ filePath: "/tmp/proj/src.ts", type: "move", movePath: "/tmp/proj/dst.ts" }],
          },
        ),
      ]),
    ]
    const metrics = createSessionMetrics("ses_patch_mv", msgs)

    expect(metrics.files.deleted).toContain("/tmp/proj/src.ts")
    expect(metrics.files.created).toContain("/tmp/proj/dst.ts")
    expect(metrics.files.modified).not.toContain("/tmp/proj/src.ts")
    expect(metrics.files.modified).not.toContain("/tmp/proj/dst.ts")
    expect(metrics.files.touched).toContain("/tmp/proj/src.ts")
    expect(metrics.files.touched).toContain("/tmp/proj/dst.ts")
  })
})
