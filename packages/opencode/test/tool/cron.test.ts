import { describe, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { SessionCronRuntime } from "@/session/cron-runtime"
import { Truncate } from "@/tool/truncate"
import { MessageID, SessionID } from "@/session/schema"
import { CronTool } from "@/tool/cron"
import * as Tool from "@/tool/tool"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([SessionCronRuntime.node, Agent.node, Truncate.node])))

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

describe("tool.cron", () => {
  it.instance("tool metadata matches schema", () =>
    Effect.gen(function* () {
      const info = yield* CronTool
      expect(info.id).toBe("cron")
      const tool = yield* info.init()
      expect(tool.description).toContain("Manage in-memory cron jobs")
    }),
  )

  it.instance("list returns empty array when no cron jobs exist for session", () =>
    Effect.gen(function* () {
      const { ctx } = createMockCtx("ses_cron_empty_" + Date.now())
      const info = yield* CronTool
      const tool = yield* info.init()

      const result = yield* tool.execute({ action: "list" }, ctx)
      expect(result.title).toBe("Session cron jobs")
      const parsed = JSON.parse(result.output)
      expect(Array.isArray(parsed)).toBe(true)
      expect(parsed.length).toBe(0)
    }),
  )

  it.instance("create triggers permission ask with cron pattern and metadata", () =>
    Effect.gen(function* () {
      const { ctx, asks } = createMockCtx("ses_cron_ask_" + Date.now())
      const info = yield* CronTool
      const tool = yield* info.init()

      const cron = "0 9 * * 1-5"
      const prompt = "Weekday morning check-in"
      const result = yield* tool.execute({ action: "create", cron, prompt }, ctx)

      expect(asks.length).toBe(1)
      expect(asks[0]!.permission).toBe("cron")
      expect(asks[0]!.patterns).toEqual(["create"])
      expect(asks[0]!.metadata).toEqual({ cron, prompt })

      const parsed = JSON.parse(result.output)
      expect(parsed.id).toBe(result.title)
      expect(parsed.cron).toBe(cron)
      expect(parsed.prompt).toBe(prompt)
      expect(parsed.recurring).toBe(true)
    }),
  )

  it.instance("create with recurring=false creates one-shot schedule", () =>
    Effect.gen(function* () {
      const { ctx } = createMockCtx("ses_cron_oneshot_" + Date.now())
      const info = yield* CronTool
      const tool = yield* info.init()

      const result = yield* tool.execute(
        { action: "create", cron: "*/10 * * * *", prompt: "One-shot review", recurring: false },
        ctx,
      )
      const parsed = JSON.parse(result.output)
      expect(parsed.recurring).toBe(false)
      expect(parsed.expiresAt).toBeUndefined()
    }),
  )

  it.instance("list returns created cron jobs for the session", () =>
    Effect.gen(function* () {
      const { ctx } = createMockCtx("ses_cron_list_" + Date.now())
      const info = yield* CronTool
      const tool = yield* info.init()

      yield* tool.execute({ action: "create", cron: "0 12 * * *", prompt: "Noon summary" }, ctx)
      yield* tool.execute({ action: "create", cron: "0 18 * * *", prompt: "Evening wrap" }, ctx)

      const listResult = yield* tool.execute({ action: "list" }, ctx)
      const items = JSON.parse(listResult.output)
      expect(items.length).toBe(2)
      expect(items.map((i: any) => i.prompt)).toEqual(["Noon summary", "Evening wrap"])
    }),
  )

  it.instance("delete removes the specified cron job", () =>
    Effect.gen(function* () {
      const { ctx } = createMockCtx("ses_cron_del_" + Date.now())
      const info = yield* CronTool
      const tool = yield* info.init()

      const created = yield* tool.execute({ action: "create", cron: "0 0 * * *", prompt: "Midnight task" }, ctx)
      const { id } = JSON.parse(created.output)

      const delResult = yield* tool.execute({ action: "delete", id }, ctx)
      expect(delResult.title).toBe(`Deleted ${id}`)

      const listResult = yield* tool.execute({ action: "list" }, ctx)
      const items = JSON.parse(listResult.output)
      expect(items.length).toBe(0)
    }),
  )

  it.instance("fails when required fields are missing or invalid", () =>
    Effect.gen(function* () {
      const { ctx } = createMockCtx("ses_cron_err_" + Date.now())
      const info = yield* CronTool
      const tool = yield* info.init()

      // Missing cron in create
      const missingCron = yield* tool.execute({ action: "create", prompt: "test" }, ctx).pipe(Effect.exit)
      expect(missingCron._tag).toBe("Failure")

      // Missing prompt in create
      const missingPrompt = yield* tool.execute({ action: "create", cron: "* * * * *" }, ctx).pipe(Effect.exit)
      expect(missingPrompt._tag).toBe("Failure")

      // Invalid cron expression
      const invalidCron = yield* tool
        .execute({ action: "create", cron: "not-a-cron", prompt: "test" }, ctx)
        .pipe(Effect.exit)
      expect(invalidCron._tag).toBe("Failure")

      // Empty prompt
      const emptyPrompt = yield* tool
        .execute({ action: "create", cron: "* * * * *", prompt: "   " }, ctx)
        .pipe(Effect.exit)
      expect(emptyPrompt._tag).toBe("Failure")

      // Missing id in delete
      const missingId = yield* tool.execute({ action: "delete" }, ctx).pipe(Effect.exit)
      expect(missingId._tag).toBe("Failure")

      // Non-existent id in delete
      const nonExistent = yield* tool.execute({ action: "delete", id: "cron_nonexistent" }, ctx).pipe(Effect.exit)
      expect(nonExistent._tag).toBe("Failure")
    }),
  )
})
