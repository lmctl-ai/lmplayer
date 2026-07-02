# Project Spec: Observability, Health & /organize-vs-/compact Measurement

Owner vertical: cli-parse + memory (shared). Builds on the shipped `session ls`/`tail`.
Operator intent: ballpark per-instance PERFORMANCE visibility + TROUBLESHOOTING, and MEASURE the novel `/organize`
(unique to lmcode) vs the old lossy `/compact` so we can compare and prove it.

## Requirements
1. `session report [<id>] [--json]` (or richer `ls`): per-session/instance metrics —
   - tokens: total input / output / cache-read / cache-write (from assistant message `tokens`), cumulative.
   - messages: count + approximate size (chars/bytes of text).
   - FILES: number written / created / modified / deleted — derive from tool-call events
     (write, edit, apply_patch add/update/delete, mkdir, touch, rm, mv, cp). List distinct file paths touched.
   - duration (first->last message time). => ballpark "this instance used N tokens, produced M files".
2. `session health [<id>]` — mirror lmctl `health` (informational, no actions):
   - CURRENT CONTEXT SIZE: tokens in the projected context window that WOULD be sent next turn
     (system + projected history + durable-memory injection), vs the model's context limit -> % used, headroom.
   - session state (busy/idle), model, message count, whether a compaction/organize has occurred.
3. `session tail` (have it) — for troubleshooting; optionally add tool-call + error lines, not just text.

## /organize vs /compact — CONFIGURABLE + MEASURED (the novel bit)
- Make the reduction mechanism selectable via config, e.g. `compaction.mode: "organize" | "summary"`
  (default organize). "summary" = the OLD lossy path (we removed it in O3 — restore it behind this flag so we can
  A/B compare). So a session can run either mode.
- MEASURE per compaction event (log + expose in report/health):
  - mode used; context tokens BEFORE vs AFTER the reduction (how much was cut); tokens spent on the organize/summary
    LLM call; resulting head size (index.md size for organize, summary length for summary); tail messages retained.
  - RETENTION quality: a needle test harness — establish distinct facts pre-compaction, reduce, then check how many
    are still answerable (organize should retain more via curated index.md; summary is lossy). Automatable via the
    mock-LLM harness (test/lib) with scripted needle Q&A.
- GOAL: numbers showing organize keeps more information at similar/lower context cost than summary — since
  /organize is novel, instrument it thoroughly (index.md size over time, tokens/turn, needle-retention %).

## STRESS TEST — small compaction trigger (operator)
- Add a config to force the compaction TRIGGER at a small fixed size (e.g. `compaction.trigger_tokens: 100000`),
  instead of firing only near the model's ~1M context limit. Wire it into the overflow predicate
  (packages/opencode/src/session/overflow.ts isOverflow): if `trigger_tokens` is set, trigger when total tokens
  >= trigger_tokens (a hard cap), else the existing limit-based logic.
- Purpose: make organize (and, behind compaction.mode:"summary", compact) fire FREQUENTLY -> a stress test on
  context management + lots of data points to compare organize vs compact. Set trigger ~100K for fleet stress runs.

## Data sources (already present)
- tokens: assistant message `tokens` field. Context projection: filterCompacted + the system assembly in
  prompt.ts (the request built each turn). Files touched: tool events (write/edit/apply_patch/mkdir/touch/rm/mv/cp).
- index.md: SessionDurableMemory (<data>/session/<id>/durable-memory/index.md) — size/growth over time.
- The organize path (compaction.ts) + the removed summary path (restore behind `compaction.mode`).

## Deliverables (autopilot backlog for this project)
- `session report` + `session health` commands (+ --json), reading tokens/files/context from the session store.
- `compaction.mode` config flag; restore the lossy summary path behind it (organize stays default).
- A measurement harness (mock-LLM) comparing organize vs summary: context reduction + needle-retention, emitting
  a small report. Tests + a short written finding (organize vs compact numbers).

## STATUS 2026-07-02 session-health slice
- Team branch: `team-observability` in `/niceapps/mma/oc/lmcode-wt/observability`.
- Worker session: `ses_0df61b134ffeMRHwmbw3lO4n75`; worker branch commit `b7f5d6a56`, integrated as `190703fd9`.
- Shipped `session health <sessionID> [--json]`, reusing `createSessionReport` aggregation for text size/token totals and adding model-limit/default context headroom output.
- Added focused CLI test `packages/opencode/test/cli/session-health.test.ts`.
- Verified on worker and integration branch with `bun run typecheck` plus `bun test test/cli/session-health.test.ts test/cli/session-report.test.ts` from `packages/opencode`.
- QA note: current context size is a practical token-usage approximation, not yet exact reconstruction of the next provider request including system/durable-memory injection.
