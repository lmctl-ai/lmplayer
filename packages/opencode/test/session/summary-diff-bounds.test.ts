/**
 * Regression coverage for the unbounded per-turn diff that a single production
 * user-message row carried (301MB). The diff is persisted on the user message
 * and re-written every turn; resume must not materialize an oversized payload.
 *
 * - summarize bounds what it persists (SUMMARY_DIFFS_MAX_BYTES).
 * - the regular message read projects `summary.diffs` away above the strip
 *   threshold, so resume never JSON.parses a legacy giant row.
 * - `Session.summaryDiffs` (used by export and SessionSummary.diff) still reads
 *   the stored value explicitly.
 */
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { MessageTable } from "@opencode-ai/core/session/sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { eq } from "drizzle-orm"
import path from "path"
import { Session } from "@/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionSummary } from "../../src/session/summary"
import { MessageID } from "@/session/schema"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { RuntimeFlags } from "@/effect/runtime-flags"

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const root = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  SessionSummary.node,
  Database.node,
  CrossSpawnSpawner.node,
  LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
])
const it = testEffect(
  LayerNode.compile(root, [
    [MCP.node, mcp],
    [LSP.node, lsp],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  ]),
)

const providerCfg = (url: string) => ({
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: url,
      },
    },
  },
})

function storedDiffs(data: unknown) {
  return (data as { summary?: { diffs?: unknown[] } } | undefined)?.summary?.diffs
}

it.live("summarize persists no diffs when the turn diff exceeds the cap", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ dir, llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const summary = yield* SessionSummary.Service
      const { db } = yield* Database.Service

      const session = yield* sessions.create({
        title: "diff cap over",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      // ~1.3MB added file: over SUMMARY_DIFFS_MAX_BYTES but under the snapshot
      // service's own per-file size limit.
      const command = `seq 1 200000 > ${path.join(dir, "big.txt")}`
      yield* llm.toolMatch((hit) => JSON.stringify(hit.body).includes("create the file"), "bash", { command })
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("bash"), "done")

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "create the file" }],
      })
      const result = yield* prompt.loop({ sessionID: session.id })
      expect(result.info.role).toBe("assistant")

      const messages = yield* sessions.messages({ sessionID: session.id })
      const user = messages.find((item) => item.info.role === "user")
      if (!user) throw new Error("Expected user message")

      // summarize() is also fire-and-forget after the loop, so poll until the
      // persisted summary settles rather than racing it.
      let stored: unknown[] | undefined
      for (let i = 0; i < 100; i++) {
        const row = yield* db
          .select({ data: MessageTable.data })
          .from(MessageTable)
          .where(eq(MessageTable.id, user.info.id))
          .get()
        stored = storedDiffs(row?.data)
        if (stored !== undefined) break
        yield* Effect.sleep("50 millis")
      }

      expect(stored).toEqual([])
      expect(yield* summary.diff({ sessionID: session.id, messageID: user.info.id })).toEqual([])
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("summarize persists the diff when it is under the cap", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ dir, llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const summary = yield* SessionSummary.Service

      const session = yield* sessions.create({
        title: "diff cap under",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      const command = `echo small > ${path.join(dir, "small.txt")}`
      yield* llm.toolMatch((hit) => JSON.stringify(hit.body).includes("create the file"), "bash", { command })
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("bash"), "done")

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "create the file" }],
      })
      yield* prompt.loop({ sessionID: session.id })

      const messages = yield* sessions.messages({ sessionID: session.id })
      const user = messages.find((item) => item.info.role === "user")
      if (!user) throw new Error("Expected user message")

      let diff: Array<{ file?: string }> = []
      for (let i = 0; i < 100; i++) {
        diff = yield* summary.diff({ sessionID: session.id, messageID: user.info.id })
        if (diff.length > 0) break
        yield* Effect.sleep("50 millis")
      }
      expect(diff.map((item) => item.file)).toContain("small.txt")
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("message read omits a legacy oversized summary.diffs but keeps it explicitly readable", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* () {
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service

      const session = yield* sessions.create({ title: "legacy giant diff" })
      const messageID = MessageID.make(`msg_${crypto.randomUUID().replaceAll("-", "")}`)
      const patch = "x".repeat(8_000_000)
      yield* db
        .insert(MessageTable)
        .values({
          id: messageID,
          session_id: session.id,
          time_created: Date.now(),
          data: {
            role: "user",
            time: { created: Date.now() },
            agent: "build",
            model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
            summary: {
              diffs: [{ file: "big.txt", additions: 1, deletions: 0, status: "modified", patch }],
            },
          } as NonNullable<(typeof MessageTable.$inferInsert)["data"]>,
        })
        .run()
        .pipe(Effect.orDie)

      const messages = yield* sessions.messages({ sessionID: session.id })
      const info = messages.find((item) => item.info.id === messageID)?.info
      if (!info) throw new Error("Expected inserted message")

      // The giant payload never reaches the resume read result.
      expect(storedDiffs(info)).toBeUndefined()
      expect(JSON.stringify(info).length).toBeLessThan(1_000_000)

      // The explicit loader still returns the stored value.
      const diffs = yield* sessions.summaryDiffs({ sessionID: session.id, messageID })
      expect(diffs).toHaveLength(1)
      expect(diffs[0]?.file).toBe("big.txt")
      expect(diffs[0]?.patch?.length).toBe(patch.length)
    }),
    { git: true, config: providerCfg },
  ),
)
