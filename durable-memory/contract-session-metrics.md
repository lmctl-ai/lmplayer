# Contract: `session metrics` — stable machine-queryable per-session metrics (ORG-METRICS)

Owner: ORG-METRICS slice. Consumers: **lmctl** `health`/queries + org-performance analyzer.
Builds on the existing `session report`/`session health` surface and the V2 token persistence
(projector `applyUsage` on `Step.Ended` → `session` table token columns). Does NOT duplicate them.

## Command

```
lmplayer session metrics <sessionID> [--json]
```

- Reads ONLY the persisted, opencode-compatible SQLite session store (messages/parts + the `session`
  row). It does NOT re-run the session. Fast + offline (no external network required).
- `--json` prints the stable schema below (single JSON object). Without `--json`, prints a compact
  human summary. `--json` is the contract lmctl consumes.

## Stable JSON schema — `session-metrics/v1`

Additive/backward-compatible: consumers must ignore unknown fields; new fields are only ever added.

```json
{
  "schema": "session-metrics/v1",
  "sessionID": "ses_...",
  "model": "github-copilot/claude-sonnet-5",
  "providerID": "github-copilot",
  "modelID": "claude-sonnet-5",
  "messages": 42,
  "turns": 8,
  "tokens": {
    "input": 12000,
    "output": 3400,
    "reasoning": 0,
    "cache": { "read": 8000, "write": 500 },
    "total": 23900
  },
  "cost_usd": 0.1234,
  "cost": { "usd": 0.1234, "source": "derived", "pricing_available": true },
  "latency_ms": {
    "total": 45000,
    "per_turn_p50": 3200,
    "per_turn_max": 9000,
    "thinking_total": 30000,
    "tool_total": 15000,
    "tool_p50": 1200,
    "tool_max": 4000
  },
  "tools": { "bash": 12, "edit": 8, "read": 20 },
  "files": {
    "created": ["src/new.ts"],
    "modified": ["src/existing.ts"],
    "deleted": [],
    "touched": ["src/existing.ts", "src/new.ts"]
  },
  "jobs": {
    "total": 3,
    "active": 0,
    "completed": 2,
    "failed": 1
  },
  "crons": {
    "total": 2,
    "recurring": 1,
    "one_shot": 1
  }
}
```

### Field rules

- `model` / `providerID` / `modelID`: from the persisted `session.model`; fall back to the latest
  assistant message's model. `model` is `"<providerID>/<modelID>"` (string) for convenience; the
  structured `providerID`/`modelID` are authoritative.
- `messages`: total persisted message count. `turns`: number of assistant messages (provider turns).
- `tokens`: PRIMARY source = the persisted `session` row totals (`session.get().tokens`, i.e. the
  `tokens_input/output/reasoning/cache_read/cache_write` columns — the SAME numbers lmctl reads
  directly). Fall back to summing `step-finish` part tokens / assistant-message tokens when the row
  totals are absent/zero. `total = input + output + reasoning + cache.read + cache.write`.
  `cache` stays `{read, write}` to match the existing lmctl token contract.
- `cost_usd` (== `cost.usd`): PRIMARY source = the persisted write-time cost from the `session`
  row (`session.cost`, populated via write-time cost calculation `Model.Cost.calculate`). When
  present and positive, `cost_usd = session.cost`, `cost.source = "persisted"`, and
  `pricing_available = true`. When `session.cost` is 0 or absent (e.g. legacy sessions before
  write-time persistence), falls back to **DERIVED** at query time = tokens × model pricing
  (`cost.source = "derived"`, `pricing_available = true`). When neither persisted cost nor pricing
  rates are available, `cost_usd = 0`, `cost.source = "unavailable"`, and `pricing_available = false`
  (never crash on missing pricing).
  - Deriving at read time ensures backward compatibility and offline fallback for older sessions.
  - Formula for derived fallback (rates are USD per 1,000,000 tokens; reasoning billed at the OUTPUT
    rate — matches `Session.getUsage` in `packages/opencode/src/session/session.ts`):
    `cost = (input*rate.input + output*rate.output + reasoning*rate.output
             + cache.read*rate.cache.read + cache.write*rate.cache.write) / 1e6`
  - Persisted `tokens_input` is already NON-cached input and `tokens_output` already EXCLUDES
    reasoning, so apply rates directly (do not re-subtract cache/reasoning).
  - `cost.source`: `"persisted"` when read from write-time `session.cost`; `"derived"` when
    recomputed at query time from token counts and pricing rates; `"unavailable"` when pricing
    could not be resolved offline and no persisted cost exists. `pricing_available`: boolean.
- `latency_ms` (all DERIVED):
  - per-turn duration = assistant `time.completed - time.created` (skip turns without `completed`).
  - `total` = sum of per-turn durations. `per_turn_p50` / `per_turn_max` over per-turn durations.
  - tool duration = tool part `state.time.end - state.time.start` (completed/error states).
  - `tool_total` / `tool_p50` / `tool_max` over tool durations.
  - `thinking_total = max(0, total - tool_total)` (model/generation time vs tool time).
  - p50 = lower-median (value at index floor((n-1)/2) of the sorted list). Empty list → 0.
- `tools`: map `toolName -> count` over all tool parts (any state).
- `files` (DERIVED via the existing `touchedFiles` operation derivation):
  - `created`: paths whose first-touch op creates a file — `write` (when the tool metadata/output
    flag says the file did NOT pre-exist, else treated as created by default), `add`, `mkdir`,
    `touch`, `cp` (dest), `mv` (dest). Authoritative metadata (`exists`/`existed` false, or
    apply_patch `status: "added"`) overrides the heuristic.
  - `modified`: paths touched by `edit`/`update`, or `write` when the file pre-existed
    (`exists`/`existed` true); excluded if already in `created`.
  - `deleted`: paths from `rm`/`delete` ops.
  - `touched`: sorted union of all touched paths.
  - Created-vs-modified is best-effort (no full FS snapshot); prefer authoritative tool metadata,
    fall back to first-touch operation heuristic.
- `jobs`: job counts for the session: `total` (count of all session background jobs), `active`
  (`queued`, `starting`, `running`), `completed` (`completed`), and `failed` (`failed`,
  `timed_out`, `cancelled`, `interrupted`). Sourced from `SessionJobStore` / HTTP API; defaults to
  all 0s when no jobs exist or store is unreachable.
- `crons`: cron schedule counts for the session: `total` (count of all active session crons),
  `recurring` (count of recurring crons), and `one_shot` (count of non-recurring crons). Sourced
  from `SessionCronRuntime`; defaults to all 0s when no crons exist or runtime is unreachable.

## Persisted vs derived (summary for the report)

- PERSISTED (read straight from SQLite/store): write-time `session.cost` (`Model.Cost.calculate`
  projected into `SessionTable.cost`); token totals + model on the `session` row; and the
  messages/parts (which carry tool names, tool `time.start/end`, assistant `time.created/completed`,
  and tool inputs/metadata used for file derivation); background jobs (`session_job` table); and
  cron schedules (`session_cron` table).
- DERIVED at query time: fallback `cost_usd` (tokens × pricing, when `session.cost` is 0 or absent),
  all `latency_ms` aggregates (p50/max/thinking-vs-tool), `tools` counts, and `files`
  created/modified/deleted bucketing.

## Implementation shape

- Pure aggregator `createSessionMetrics(sessionID, messages, { session?, pricing? })` in
  `packages/opencode/src/cli/cmd/session.ts`, reusing `createSessionReport`'s helpers
  (`touchedFiles`, `emptyTokens`, `addTokens`, file-op derivation). Pure + unit-testable exactly like
  `createSessionReport` (no server/DB in the test).
- `SessionMetricsCommand` (`metrics <sessionID> --json`) registered in `SessionCommand.builder`.
  Handler uses the existing in-process `localSdk()` to fetch `session.get` + `session.messages`,
  resolves pricing via `Provider.Service.getModel(providerID, modelID)` (graceful `undefined` on
  failure so the command stays offline-safe), then calls the pure aggregator and prints JSON.

## Directly fixes

lmctl `health` showing `Tokens: n/a` and missing price: `session metrics --json` returns the same
persisted token totals lmctl already reads, PLUS a derived `cost_usd`, latency, tools, and files.

## STATUS 2026-07-07 session-metrics slice (delivered)

- Branch `session-metrics` (off `dev`), merged to `dev` when green. Not pushed.
- Files: `packages/opencode/src/cli/cmd/session.ts` (`createSessionMetrics` + `SessionMetricsCommand`
  + `formatSessionMetrics` + helpers `p50`/`deriveFileBuckets`/`bucketedPathOps`/`applyPatchBuckets`),
  new test `packages/opencode/test/cli/session-metrics.test.ts` (23 cases).
- Process: Lead (opus-4.8) designed the contract; Coder (`claude-sonnet-4.6` via provider=lmplayer —
  substitute for the requested `claude-sonnet-5`, which 404s via copilot here) implemented; Reviewer
  (`gpt-5.5`, different provider) did adversarial review → 3 blockers + 1 nit → fixed → **SIGNED OFF**.
  Fixes: fail-fast on absent session; pricing uses effective model (session.model ?? latest assistant);
  `mv`/`apply_patch move` mark source `deleted` + dest `created`.
- Verified: `bun typecheck` clean + `bun test test/cli/session-metrics.test.ts test/cli/session-report.test.ts
  test/cli/session-health.test.ts` = 23 pass / 0 fail (from `packages/opencode`). Real offline e2e against a
  persisted dev-DB session produced correct tokens (7.9M total), `cost_usd` $4.22 (derived), tool counts,
  and created/modified files; absent session exits 1 with "Session not found".
- Write-time cost persistence (DELIVERED 2026-09-18): `Model.Cost.calculate` computes
  real write-time cost from model pricing rates and token counts (accounting for context tiers,
  input, output, reasoning, and cache read/write); `SessionRunnerModel` exposes `resolveInfo`;
  `createLLMEventPublisher` computes and records `cost` in `stepSettlement`; and
  `packages/core/src/session/runner/llm.ts` publishes `cost: stepSettlement.cost` in
  `SessionEvent.Step.Ended`, projecting real cost into `SessionTable.cost` and assistant messages.

## STATUS 2026-09-18 jobs observability extension (delivered)

- Extended `session-metrics/v1` schema with additive `jobs: { total, active, completed, failed }` breakdown.
- CLI subcommand added: `lmplayer session jobs <sessionID> [--json] [--output <jobID>] [--job <jobID>] [--status <status>]`.
- Tested in `test/cli/session-metrics.test.ts`, `test/cli/session-jobs.test.ts`, and `test/cli/session-commands.test.ts`.

## STATUS 2026-09-18 crons observability & durable persistence extension (delivered)

- Extended `session-metrics/v1` schema with additive `crons: { total, recurring, one_shot }` breakdown.
- CLI subcommand added: `lmplayer session crons <sessionID> [--json] [--cron <cronID>] [--delete <cronID>]`.
- Durable SQLite persistence in `@opencode-ai/core` schema (`session_cron` table with foreign key cascade to `session.id`) and `SessionCronRuntime` SQLite storage & restart recovery.
- Tested in `test/database-migration.test.ts`, `test/session/cron-runtime.test.ts`, `test/cli/session-metrics.test.ts`, `test/cli/session-crons.test.ts`, and `test/cli/session-commands.test.ts`.

## STATUS 2026-09-18 persisted write-time cost integration (delivered)

- Updated `createSessionMetrics` in `packages/opencode/src/cli/cmd/session.ts` to check `options?.session?.cost > 0` first:
  - Reports `cost_usd = session.cost`, `cost.source = "persisted"`, and `pricing_available = true`.
  - Seamlessly falls back to derived token multiplication (`cost.source = "derived"`) when `session.cost` is 0/absent and `pricing` is provided.
  - Falls back to `cost.source = "unavailable"` when both persisted cost and pricing rates are absent.
- Updated `formatSessionMetrics` human-readable output to display `Cost: $... (persisted)`.
- Added unit tests in `packages/opencode/test/cli/session-metrics.test.ts` (30/30 pass) covering persisted cost precedence, fallbacks, and formatted display.


