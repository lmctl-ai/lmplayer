import { describe, expect, test } from "bun:test"
import { createSessionReport, type SessionMessage } from "@/cli/cmd/session"

type ToolPart = Extract<SessionMessage["parts"][number], { type: "tool" }>
type TextPart = Extract<SessionMessage["parts"][number], { type: "text" }>
type StepFinishPart = Extract<SessionMessage["parts"][number], { type: "step-finish" }>

const tokens = {
  total: 15,
  input: 5,
  output: 7,
  reasoning: 3,
  cache: {
    read: 2,
    write: 1,
  },
}

function textPart(messageID: string, text: string): TextPart {
  return {
    id: `prt-text-${messageID}`,
    sessionID: "ses_report",
    messageID,
    type: "text",
    text,
  }
}

function stepFinishPart(messageID: string): StepFinishPart {
  return {
    id: `prt-finish-${messageID}`,
    sessionID: "ses_report",
    messageID,
    type: "step-finish",
    reason: "stop",
    cost: 0.01,
    tokens,
  }
}

function toolPart(messageID: string, tool: string, input: Record<string, unknown>, metadata: Record<string, unknown>): ToolPart {
  return {
    id: `prt-tool-${messageID}-${tool}`,
    sessionID: "ses_report",
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
      time: {
        start: 100,
        end: 200,
      },
    },
  }
}

function userMessage(id: string, created: number, parts: SessionMessage["parts"]): SessionMessage {
  return {
    info: {
      id,
      sessionID: "ses_report",
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
      sessionID: "ses_report",
      role: "assistant",
      time: {
        created,
      },
      parentID: "msg-user-1",
      modelID: "test",
      providerID: "test",
      mode: "chat",
      agent: "build",
      path: {
        cwd: "/tmp/project",
        root: "/tmp/project",
      },
      cost: 0.01,
      tokens: {
        total: 100,
        input: 50,
        output: 30,
        reasoning: 20,
        cache: {
          read: 10,
          write: 5,
        },
      },
    },
    parts,
  }
}

describe("session report", () => {
  test("aggregates text, tokens, duration, and touched files", () => {
    const report = createSessionReport("ses_report", [
      userMessage("msg-user-1", 1_000, [textPart("msg-user-1", "hello ")]),
      assistantMessage("msg-assistant-1", 4_000, [
        textPart("msg-assistant-1", "é"),
        stepFinishPart("msg-assistant-1"),
        toolPart("msg-assistant-1", "write", { filePath: "/tmp/project/a.ts" }, { filepath: "/tmp/project/a.ts" }),
        toolPart("msg-assistant-1", "rm", { paths: ["/tmp/project/old.ts"] }, { paths: ["/tmp/project/old.ts"] }),
        toolPart("msg-assistant-1", "apply_patch", { patchText: "patch" }, {
          files: [
            { filePath: "/tmp/project/new.ts", type: "add" },
            { filePath: "/tmp/project/change.ts", type: "update" },
            { filePath: "/tmp/project/gone.ts", type: "delete" },
          ],
        }),
      ]),
      assistantMessage("msg-assistant-2", 2_500, [
        toolPart("msg-assistant-2", "mv", { source: "/tmp/project/a.ts", dest: "/tmp/project/b.ts" }, {}),
        toolPart("msg-assistant-2", "cp", { source: "/tmp/project/b.ts", dest: "/tmp/project/c.ts" }, {}),
        toolPart("msg-assistant-2", "mkdir", { path: "/tmp/project/dir" }, {}),
        toolPart("msg-assistant-2", "touch", { path: "/tmp/project/dir/touched.ts" }, {}),
      ]),
    ])

    expect(report.messageCount).toBe(3)
    expect(report.text).toEqual({ chars: 7, bytes: 8 })
    expect(report.duration).toEqual({ start: 1_000, end: 4_000, milliseconds: 3_000 })
    expect(report.tokens).toEqual({
      total: 115,
      input: 55,
      output: 37,
      reasoning: 23,
      cache: {
        read: 12,
        write: 6,
      },
    })
    expect(report.files.count).toBe(9)
    expect(report.files.operations).toMatchObject({
      write: 1,
      add: 1,
      update: 1,
      delete: 1,
      mkdir: 1,
      touch: 1,
      rm: 1,
      mv: 2,
      cp: 2,
    })
    expect(report.files.paths).toEqual([
      "/tmp/project/a.ts",
      "/tmp/project/b.ts",
      "/tmp/project/c.ts",
      "/tmp/project/change.ts",
      "/tmp/project/dir",
      "/tmp/project/dir/touched.ts",
      "/tmp/project/gone.ts",
      "/tmp/project/new.ts",
      "/tmp/project/old.ts",
    ])
    expect(report.files.touched.find((file) => file.path === "/tmp/project/a.ts")?.operations).toMatchObject({
      write: 1,
      mv: 1,
    })
  })
})
