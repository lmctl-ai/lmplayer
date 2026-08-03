import { describe, expect, it } from "bun:test"
import { jsonSchema, tool } from "ai"
import { configureNotificationWorkflowApproval, notificationDispatchTools } from "@/session/llm"
import { assertNotificationToolCall } from "@/tool/job"

describe("notification-origin tools", () => {
  it("denies fabricated and stale tool names at final dispatch", async () => {
    let executed = false
    const inert = () =>
      tool({
        inputSchema: jsonSchema({ type: "object" }),
        execute: async () => ({ title: "inert", metadata: {}, output: "" }),
      })
    const guarded = notificationDispatchTools({
      job: tool({
        inputSchema: jsonSchema({ type: "object" }),
        execute: async () => {
          executed = true
          return { title: "job", metadata: {}, output: "ok" }
        },
      }),
      shell: inert(),
      fabricated: inert(),
    })

    expect(Object.keys(guarded)).toEqual(["job"])
    expect(guarded.shell).toBeUndefined()
    expect(guarded.fabricated).toBeUndefined()
    expect(() => assertNotificationToolCall("shell", {})).toThrow()
    expect(() => assertNotificationToolCall("job", { action: "stop", jobID: "job_1" })).toThrow()
    expect(() =>
      guarded.job?.execute?.(
        { action: "stop", jobID: "job_1" },
        { toolCallId: "call", messages: [], abortSignal: new AbortController().signal },
      ),
    ).toThrow()
    expect(executed).toBe(false)
  })

  it("preapproves only safe job reads for unattended workflow turns without asking permission", async () => {
    const workflow: {
      sessionPreapprovedTools?: string[]
      approvalHandler?: (tools: { name: string; args: string }[]) => Promise<{ approved: boolean }>
    } = {}
    configureNotificationWorkflowApproval(workflow)

    expect(workflow.sessionPreapprovedTools).toEqual(["job"])
    expect(
      await workflow.approvalHandler?.([{ name: "job", args: JSON.stringify({ action: "list" }) }]),
    ).toEqual({ approved: true })
    expect(
      await workflow.approvalHandler?.([
        { name: "job", args: JSON.stringify({ action: "stop", jobID: "job_1" }) },
      ]),
    ).toEqual({ approved: false })
    expect(await workflow.approvalHandler?.([{ name: "shell", args: JSON.stringify({ command: "pwd" }) }])).toEqual(
      { approved: false },
    )
  })
})
