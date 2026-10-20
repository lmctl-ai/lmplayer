/**
 * Regression coverage for SessionTable.summary_diffs, a schema-identical
 * sibling of MessageTable's per-turn `summary.diffs` (see
 * summary-diff-bounds.test.ts). It carries the same unbounded-against-tree-size
 * payload and is reachable via session import, with no protection of its own:
 * Session.get() did a plain select (JSON-parsing the full column on every read)
 * and patch()/touch() round-tripped whatever `get()` returned back into the row
 * on unrelated writes.
 *
 * - the regular session read (get/children) projects `summary_diffs` away above
 *   the same threshold as MessageV2.STRIP_DIFFS_ABOVE_BYTES.
 * - `Session.sessionSummaryDiffs` is the explicit loader for callers that still
 *   want the stored value (export).
 * - an unrelated touch()/patch() on a session with a legacy giant row no longer
 *   round-trips the giant value.
 */
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { eq, sql } from "drizzle-orm"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
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
  Session.node,
  SessionProjector.node,
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

const giantPatch = "x".repeat(8_000_000)

function insertGiantSessionDiff(db: Database.Interface["db"], sessionID: SessionID) {
  return db
    .update(SessionTable)
    .set({
      summary_additions: 1,
      summary_deletions: 0,
      summary_files: 1,
      summary_diffs: [{ file: "big.txt", additions: 1, deletions: 0, status: "modified" as const, patch: giantPatch }],
    })
    .where(eq(SessionTable.id, sessionID))
    .run()
    .pipe(Effect.orDie)
}

it.live("session read omits a legacy oversized summary_diffs but keeps it explicitly readable", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* () {
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service

      const session = yield* sessions.create({ title: "legacy giant session diff" })
      yield* insertGiantSessionDiff(db, session.id)

      const info = yield* sessions.get(session.id)
      expect(info.summary?.diffs).toBeUndefined()
      expect(JSON.stringify(info).length).toBeLessThan(1_000_000)

      const diffs = yield* sessions.sessionSummaryDiffs(session.id)
      expect(diffs).toHaveLength(1)
      expect(diffs[0]?.file).toBe("big.txt")
      expect(diffs[0]?.patch?.length).toBe(8_000_000)
    }),
    { git: true },
  ),
)

it.live("touch() on a session with a legacy giant summary_diffs does not round-trip the giant value", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* () {
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service

      const session = yield* sessions.create({ title: "legacy giant session diff" })
      yield* insertGiantSessionDiff(db, session.id)

      const rawLen = () =>
        db
          .select({ len: sql<number>`length(${SessionTable.summary_diffs})` })
          .from(SessionTable)
          .where(eq(SessionTable.id, session.id))
          .get()
          .pipe(Effect.orDie)

      const before = yield* rawLen()
      expect(before?.len ?? 0).toBeGreaterThan(4_000_000)

      // patch()/touch() read the session via get() (now stripped above the
      // threshold), so `current.summary.diffs` is undefined before it is
      // carried into the republished event; the ORM then omits that key from
      // the UPDATE entirely (undefined means "leave column as-is", not
      // "clear it") rather than re-serializing an 8MB array on every touch.
      yield* sessions.touch(session.id)

      const after = yield* rawLen()
      expect(after?.len).toBe(before?.len)

      // The amplification cycle (re-parse a giant value on every read) is
      // broken: a get() after the unrelated touch() is still bounded.
      const info = yield* sessions.get(session.id)
      expect(info.summary?.diffs).toBeUndefined()
      expect(JSON.stringify(info).length).toBeLessThan(1_000_000)
    }),
    { git: true },
  ),
)
