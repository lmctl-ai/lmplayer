# Design: Bound Non-OpenAI Provider Timeouts

**Author:** lmplayerAgy:Lead  
**Date:** 2026-09-16  
**Status:** PROPOSAL — design only, no code  
**Context:** The production incident (provider parked in `epoll_wait`, hanging dispatches for hours) was fixed for OpenAI by `baaabfff44` + `953f0352bd`. The same bug is still live for every other provider.

---

## 1. Does the OpenAI mechanism generalise?

**Yes, completely. No per-provider work needed.**

The timeout infrastructure is provider-agnostic. Every provider — OpenAI, Copilot, Ollama, Anthropic, Azure, Meta, xAI, custom — goes through the same fetch wrapper at [`provider.ts:1927-1962`](file:///home/mma/repos/providers/lmplayer/packages/opencode/src/provider/provider.ts#L1927-L1962):

1. `options["headerTimeout"]` → `timeoutController` → AbortSignal (time-to-first-headers)
2. `options["chunkTimeout"]` → `wrapSSE` → `IdleTimeoutError` (SSE idle gap)
3. `options["timeout"]` → `AbortSignal.timeout` (total request wall clock)
4. All three composed via `AbortSignal.any` → `fetchWithAbort` (cancellation guard)

The **only** reason non-OpenAI providers are unbounded is that their custom loaders (`custom()` function, lines 177–300) return `options: {}` — no timeout keys. The `openai` loader returns `options: { headerTimeout: 300_000, chunkTimeout: 300_000, timeout: 1_800_000 }`.

**The fix is to set defaults in each loader's `options`, or — simpler — set universal defaults in the fetch wrapper itself, so any provider without explicit timeout options still gets bounded.**

### Recommendation: universal defaults in the fetch wrapper

Rather than adding the same three keys to every custom loader (anthropic, github-copilot, meta, xai, azure, ollama, opencode, and any future custom provider), inject defaults at the consumption site (lines 1928-1929):

```typescript
const chunkTimeout = options["chunkTimeout"] ?? PROVIDER_CHUNK_TIMEOUT_DEFAULT
const headerTimeout = options["headerTimeout"] ?? PROVIDER_HEADER_TIMEOUT_DEFAULT
// ...and for total timeout, if undefined/null (not explicitly false):
if (options["timeout"] === undefined || options["timeout"] === null) options["timeout"] = PROVIDER_TOTAL_TIMEOUT_DEFAULT
```

This is a **one-site change** that covers all current and future providers. A loader that wants different values (OpenAI already does) still overrides. A loader that explicitly sets `false` still opts out. The existing `options["timeout"] !== false` guard at line 1944 already handles the opt-out.

The OpenAI-specific `OPENAI_HEADER_TIMEOUT_DEFAULT` at line 37 can remain as-is (its value happens to equal the universal default), or be replaced by the universal constant. Either way, OpenAI's explicit `options` override the universal defaults, so behavior is unchanged.

---

## 2. What the defaults should be

| Bound                | Proposed default      | Why                                                                                                                                                                                                                        |
| -------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Header timeout**   | 300 000 ms (5 min)    | Match OpenAI. Headers should arrive quickly; 5 min is generous enough for cold starts and auth handshakes (Copilot OAuth, Ollama model loading), strict enough to detect a dead endpoint.                                  |
| **SSE idle timeout** | 300 000 ms (5 min)    | Match OpenAI. The production incident was a stall _after_ headers arrived; this is the bound that would have prevented it. 5 min tolerates long "thinking" pauses (Anthropic extended thinking, Copilot reasoning models). |
| **Total timeout**    | 1 800 000 ms (30 min) | Match OpenAI. A single LLM turn should not run for 30 minutes. This is a safety ceiling, not an expected duration. If a provider legitimately needs longer (unlikely), the user can set `timeout: false` in config.        |

### Why match OpenAI rather than pick different numbers?

- **Consistency**: the operator should not need to remember which provider has which ceiling.
- **The OpenAI numbers were chosen for the same problem**: bounding a stalled provider response without prematurely aborting legitimate long responses.
- **Evidence**: 300s idle + 1800s total have been in production on OpenAI since `baaabfff44` (2026-09-14) with no reports of premature abort.
- **Override is trivial**: any provider can have per-provider values via `provider.<id>.options.headerTimeout/chunkTimeout/timeout` in config. `false` disables.

### Ollama special case?

Ollama runs locally and may need to load a model from disk on first request (can take 30-60s on spinning disk). The 300s header timeout is already generous for this. If a user runs a quantized 70B model on slow hardware, they can set `provider.ollama.options.headerTimeout: 600000`. No special default needed.

---

## 3. What happens to a provider that ignores `AbortSignal`

This is already handled by `fetchWithAbort` ([`fetch-abort.ts`](file:///home/mma/repos/providers/lmplayer/packages/opencode/src/provider/fetch-abort.ts)), added in `953f0352bd`:

```typescript
export async function fetchWithAbort<T>(run: () => Promise<T>, signal?: AbortSignal | null): Promise<T> {
  signal?.throwIfAborted()
  if (!signal) return run()
  // ...
  return await Promise.race([run(), cancelled])
}
```

When the combined signal fires (from any of header/chunk/total timeout), `fetchWithAbort` rejects the caller's promise via `Promise.race` — **even if the underlying fetch ignores the signal and keeps a socket open**. The caller is unblocked.

### What `fetchWithAbort` does NOT do

It **does not destroy the underlying connection**. If a custom fetch plugin holds a TCP socket, that socket may leak until the process exits or GC collects it. The backlog doc (`provider-stall-timeout.md`) states this explicitly: _"it does not claim to destroy resources privately owned by arbitrary plugins."_

This is acceptable because:

- The primary goal is to **release the caller** (the session loop / dispatch), not clean up every resource.
- A leaked socket is a minor resource issue; a hung dispatch is a production outage.
- The universal defaults mean the socket will be abandoned within 30 min at worst; process recycle (refresh) handles the rest.

### No new work needed here

The `fetchWithAbort` wrapper is already applied at the universal fetch site (line 1950). Adding universal timeout defaults automatically causes the combined signal to fire for all providers, which `fetchWithAbort` already handles. This is the beauty of the architecture: one site, already wired.

---

## 4. Aggregate deadline gap: what bounds a turn that is not waiting on a provider response?

### The honest answer: NOTHING bounds a non-provider turn today

If an agent turn is not waiting on an active provider HTTP stream, **there is currently zero wall-clock deadline bounding it anywhere in the system**.

### Live Evidence: `lmdbview:Lead` (agy / Gemini 3.8 Flash High, 2026-09-17)

Two consecutive turns stalled on the same host, losing ~3.5 hours of wall clock:

- **Turn 1**: `elapsed 1:59:42`, `CPU 00:01:06`, kernel state `do_epoll_wait`, repo writes: 0, members idle 1h
- **Turn 2**: `elapsed 1:39:56`, `CPU 00:01:00`, kernel state `futex_do_wait`, repo writes: 0

Healthy turns on the same model/host take **minutes** with steady disk writes. In both stalled turns, the process burned only ~60s of CPU over ~2 hours, parked in a kernel wait state.

**Crucial architectural conclusion:** A 300s SSE idle timeout on the provider stream would **not** have caught either of these incidents. The process was not waiting on a provider HTTP response; it was parked in `epoll_wait` (event loop waiting on I/O or an event that never fired) and `futex_do_wait` (thread mutex/condvar contention, e.g. SQLite lock or runtime lock).

### Detailed breakdown of current non-provider bounds

| Layer                                                 | Current State                                                                                                                                | What Happens When Wedged                                                                     |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **CLI batch run** (`run.ts:778-949`)                  | Listens to `events.stream` until `session.status: idle`. No timeout.                                                                         | Parks indefinitely waiting for event stream closure or idle status.                          |
| **Server execution gate** (`execution-gate.ts:36-49`) | `serialize(effect)` acquires `executionGate.withPermits(1)`. No timeout on `effect`.                                                         | Holds the global permit forever, blocking all subsequent prompts/commands across the server. |
| **Prompt loop** (`prompt.ts:1113-1350`)               | `while (true)` loop over steps. No aggregate turn deadline, no max total duration.                                                           | Loops or parks indefinitely.                                                                 |
| **Tool execution**                                    | Bash tool has `MAX_TIMEOUT_MS = 10 min` (default 2 min). MCP tools have optional `entry.timeout`. Native file/git tools have **no timeout**. | A single hung native tool or an infinite tool loop runs without a ceiling.                   |
| **Subagents / tasks**                                 | `ops.prompt` re-enters in-process, bypassing the execution gate.                                                                             | Recursive subagent calls inherit the unbounded turn lifetime.                                |

### Rough Sizing: The Aggregate Turn Deadline Piece

To bound turns outside the provider stream, work must happen at two distinct layers:

#### Tier 1: In-Process Turn Deadline (Effect-Level) — ~1 to 2 days

- **Where**: `packages/opencode/src/server/execution-gate.ts` (or `handlers/session.ts`) wrapping `serialize(promptSvc.prompt(...))`.
- **Mechanism**: Wrap the execution effect with `Effect.timeoutFail` or `Effect.timeout` (e.g. default 45 minutes, configurable via `config.turn_timeout_ms` / `LMPLAYER_TURN_TIMEOUT_MS`).
- **Behavior on timeout**:
  1. Effect fiber tree is interrupted (cancelling child fibers).
  2. `Effect.onInterrupt` in `prompt.ts` / `processor.ts` already triggers `finalizeInterruptedAssistant` (marks assistant message aborted, sets `completed` timestamp).
  3. Releases the `executionGate` semaphore permit so subsequent requests are not wedged.
  4. Publishes `session.error` and transitions session status to `idle`.
- **Scope & Complexity**:
  - ~150–250 lines of production code + tests.
  - Needs clean error schema (`TurnTimeoutError`), config field, and a regression test using `TestLLMServer` with a delayed tool call or mock hold.
- **Limitation**: Fiber interruption relies on the JavaScript/Effect runtime event loop continuing to process timer callbacks. This will successfully catch `epoll_wait` where libuv can fire an expired timer. It **cannot** recover if a native thread is permanently deadlocked in a synchronous kernel `futex_do_wait` that blocks the JS event loop entirely.

#### Tier 2: External Supervisor Watchdog (Host / lmctl / Orchestrator) — ~1 day

- **Where**: External process layer (`lmctl` turn runner or `orchestrator` container supervisor).
- **Mechanism**: Wall-clock deadline per turn dispatch (e.g. 45–60 minutes).
- **Behavior on timeout**: If the container does not emit events or complete the turn within the budget:
  1. Send `SIGTERM` (which invokes lmplayer's `beginDrain` with a 10s graceful shutdown budget).
  2. If still unyielding after 10s, send `SIGKILL`.
  3. Recycle container / mark member errored.
- **Scope**: Belongs in the harness (`lmctl` / container orchestrator), not inside lmplayer's process. This is the **only** 100% guarantee against native kernel lockups like `futex_do_wait`.

### Recommendation on Sequencing

1. **Ship the Universal Provider Timeouts first** (Delivered in `cd5f5a932b`). Universal provider timeout defaults (header 300s, SSE idle chunk 300s, total 1800s) + terminal `HeaderTimeoutError`.
2. **Take Tier 1 (In-process Turn Deadline) as the immediate next task** (Delivered). 45m aggregate execution gate deadline, `TurnTimeoutError` (504), cleanup on deadline.
3. **Ensure Tier 2 (External watchdog)** is active in the lmctl harness to backstop native runtime deadlocks.

---

## Summary: proposed change

|                    |                                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What**           | 1. Add universal provider timeout defaults (`PROVIDER_HEADER_TIMEOUT_DEFAULT = 300_000`, `PROVIDER_CHUNK_TIMEOUT_DEFAULT = 300_000`, `PROVIDER_TOTAL_TIMEOUT_DEFAULT = 1_800_000`) at the universal fetch wrapper.<br>2. Make `HeaderTimeoutError` terminal in `retry.ts` (`metadata.code === "ProviderHeaderTimeoutError"` returns `undefined`). |
| **Where**          | `packages/opencode/src/provider/provider.ts` lines 1928-1929 + 1944; `packages/opencode/src/session/retry.ts` line 89.                                                                                                                                                                                                                            |
| **Size**           | ~12 lines of production code.                                                                                                                                                                                                                                                                                                                     |
| **Tests**          | Extend `header-timeout.test.ts` to verify universal defaults apply to a provider with no explicit options, and verify `HeaderTimeoutError` is non-retryable.                                                                                                                                                                                      |
| **Documented Gap** | **Non-provider turn execution is unbounded today.** Documented above with live `lmdbview:Lead` evidence; Tier 1 turn deadline (~1-2 days) sized for follow-up.                                                                                                                                                                                    |
| **Risk**           | Low. Additive; explicit overrides preserved; closes 27-min header cascade.                                                                                                                                                                                                                                                                        |
