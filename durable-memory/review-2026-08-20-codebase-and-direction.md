# Review 2026-08-20: codebase + direction after the session-job/cron port

Reviewer: Fable (external deep review, requested by Lead). Scope: verify the three
direction pillars against current `dev` (HEAD `9d098f4e8`), audit the freshly-merged
background-job + cron subsystem against the sequential-execution pillar, run the real
test suites, inventory half-finished work, and propose next directions. Everything
below is code-verified at the cited file:line on this HEAD, not taken from docs.

## 1. Pillar verification (direction.md claims all three DONE)

1. **File-based permissions, no popup — HOLDS.** `permission/index.ts:70-101`: any
   residual "ask" (explicit ask rule or no match) collapses to config
   `permission_ask` (default `deny`) BEFORE anything blocks or emits an Asked event.
   The interactive Deferred machinery below it is unreachable (`needsAsk` never set;
   acknowledged in the comment at :98-100). Nothing on the run/serve path blocks on
   a human.
2. **Standalone config — HOLDS.** `config/paths.ts:14-38`: `files()` reads only the
   start directory's own `opencode.json(c)`; `worktree` param accepted but ignored
   (no walk-up); `directories()` = global config dir + the start dir's own
   `.opencode` + explicit `OPENCODE_CONFIG_DIR` only. No ancestor/sibling merge.
3. **Single-user sequential execution — HOLDS ONLY FOR HTTP-ORIGIN TURNS.** The
   process-global FIFO `Semaphore(1)` lives in `server/execution-gate.ts:16` and is
   applied strictly at the HTTP handler boundary (`handlers/session.ts:383,425,447,
   474,499,511,592` — init/summarize/prompt/promptAsync/command/shell/import).
   Subagents bypass by design (in-process `ops.prompt`; documented at
   execution-gate.ts:10-15). ACP prompts DO go through the gate (they re-enter via
   the SDK HTTP client, `acp/service.ts:514`). But the new job/cron subsystem
   introduced two NEW turn origins that do NOT (next section). Pillar 3 as stated in
   execution-gate.ts:4-6 ("only ONE agent run ... across the whole server") no
   longer holds.

## 2. HEADLINE: job-notification and cron turns bypass the sequential gate

Be precise about what is and isn't a violation:

- The background **shell process** running concurrently with turns is FINE and
  intentional — that is the entire point of `bash background:true`
  (`tool/shell.ts:633-677` submits and returns immediately; the process runs under
  `SessionJobRuntime.launch`, job-runtime.ts:130-327).
- The **prompt turns** those features generate are NOT gated. Chain:
  - Job completes → `publishCompleted` → `wake(sessionID)` (job-runtime.ts:111-112)
    → `scheduleNotification` (prompt.ts:1696) → retry owner (notification-retry.ts)
    → `runNotificationAttempt` → `state.wake(...)` (prompt.ts:1669) → per-session
    `Runner.requestRun` (run-state.ts:132-140, effect/runner.ts:170-234) → `notify()`
    synthesizes a user message and calls `runLoop(sessionID)` (prompt.ts:1618) — a
    full LLM turn with the full toolset. `serialize()` is never on this path.
  - Cron fires on a 30s tick timer (cron-runtime.ts:225, `tick` :153) →
    `crons.setWake` callback (prompt.ts:1697-1764) → `state.wakeIfIdle` (:1713) →
    `runLoop` (:1750). Also ungated. `wakeIfIdle` checks the SESSION runner is idle
    (run-state.ts:142-150, runner.ts:182), not that the server is idle.

Consequences (all cross-session; same-session is serialized by the per-session
Runner, whose pending-work chaining at runner.ts:183-196 gives FIFO within one
session):

- A notification or cron turn in session B runs CONCURRENTLY with a gated HTTP turn
  in session A → two LLM turns at once; violates the pillar.
- Two notification/cron turns in different sessions run concurrently with each other.
- Drain is porous: `beginDrain`/`gracefulShutdown` (execution-gate.ts:54-80) only
  waits on the gate permit, so a cron fire or job completion DURING drain starts a
  fresh ungated LLM turn that `process.exit(0)` then kills mid-flight.

Root cause: the subsystem was ported from a sibling opencode fork, which has no
execution gate — the gate is lmplayer-specific (added by `e5b7033ab`). Nobody
reconciled the two; `research-background-jobs.md:282-284` shows the gate was
understood pre-port, but the port didn't route the new turn origins through it.

**Fix sketch (bounded):** acquire the gate in the wake CALLERS, before entering the
session runner — i.e. wrap the body of `runNotificationAttempt` (the
`state.wake(...)` + `yield* request.settled` block, prompt.ts:1665-1674) and the
cron setWake callback's `state.wakeIfIdle` + `Deferred.await(persisted)` block
(prompt.ts:1711-1754) in `serialize()` from execution-gate. Lock ordering stays
global-permit → session-runner on every path, matching the HTTP handlers — no
deadlock. Do NOT instead wrap the `work` effect that runs INSIDE the runner: that
inverts the order (runner → permit) and deadlocks against an HTTP request holding
the permit while waiting on the same session's runner. Drain behavior falls out
free: a gated wake during drain gets 503-rejected; the retry owner degrades and the
durable notification redelivers on next startup (`reconcileStale` →
`notify(startupPending)`, job-runtime.ts:68-75,464-473). Both wake callers already
tolerate `accepted:false`/failure (notification-retry.ts:40-63 retries;
cron-runtime.ts:191-199 resets `firingMinute` and refires later). Add an
integration test with the existing mock harness (test/lib/llm-server.ts `hold`)
asserting a job-completion turn in session B cannot overlap a held HTTP turn in
session A.

## 3. Missing port: notification-claim liveness fix (CHANGELOG is wrong)

CHANGELOG `[Unreleased]` ("The deepest fix") claims a `notification_claim_pid`
column + `processAlive()` check prevents a new process from reclaiming a
notification claim held by a still-alive process. **That fix is NOT in lmplayer.**
`grep -r notification_claim_pid packages/` → zero hits. It is sibling-fork commit
`eaa7ccbf6` (2026-08-15, sibling opencode fork HEAD: migration
`20260815012222_add_notification_claim_pid` + ~97-line job-store change) — the tip
commit that the 19-commit cherry-pick missed. Today in lmplayer, `reconcileStale`
releases "claimed" notifications purely on lease expiry
(job-store.ts:392-403) and the lease is 30s (`claimNotifications`,
job-store.ts:502,519). A notification LLM turn routinely exceeds 30s, and
`SessionJobRuntime` startup reconciles ALL sessions in the shared DB
(job-runtime.ts:68-75), so ANY new opencode process on the host (e.g. a one-shot
`lmplayer run`) can steal a live claim mid-turn → duplicate notification turns /
`Effect.die("...did not update its admitted batch")` (prompt.ts:1628). Job-LAUNCH
reclaim already has the liveness check (`processAlive`, job-store.ts:352,837);
notification claims don't. Action: cherry-pick `eaa7ccbf6` (mechanical; brings the
migration) and fix the CHANGELOG sentence if not.

## 4. Shutdown split-brain: serve's SIGTERM path skips job shutdown

Two exit paths disagree:

- One-shot CLI (`run` etc.): `index.ts:165-194` explicitly runs
  `SessionJobRuntime.shutdown()` (bounded 10s) before `process.exit()` — kills owned
  job processes and reconciles their rows (`reconcileOwned`), precisely because the
  Scope finalizer is unreliable (doc comment at job-runtime.ts:40-48).
- `serve` on SIGTERM/SIGINT/POST /shutdown: `serve.ts:25-26` →
  `gracefulShutdown` (execution-gate.ts:71-80) drains the gate then calls
  `process.exit(0)` directly — `SessionJobRuntime.shutdown()` never runs. Detached
  job processes (`detached: true`, job-runtime.ts:212) survive as orphans; their
  rows are later marked "interrupted" by the next process's `reconcileStale` even
  though the orphan may still be running and mutating the workspace. Cron also keeps
  ticking throughout the drain window (§2).

Fix: `gracefulShutdown` should run the same bounded `SessionJobRuntime.shutdown()`
(and stop the cron ticker) between drain-complete and exit.

## 5. Architectural coherence of the port

- **Good fits:** the `job`/`cron` tools register through the normal registry
  (tool/registry.ts:132-133), so profiles/provision and permission tool-disable
  apply to them like any tool. Background submission runs the SAME permission scan
  as foreground bash (`ask(ctx, scan, params)` at shell.ts:628 happens before the
  `background` branch). `job stop` asks under permission `job`
  (tool/job.ts:48-53). Notification-origin turns carry
  `SessionTurnContext.notificationOrigin` and plugin hooks are timeout-guarded on
  that path (fixed post-merge in `33694216e`).
- **Gap: `cron create` never asks.** tool/cron.ts has no `ctx.ask` — a model can
  schedule arbitrary future self-prompts (up to 16/session, cron-runtime.ts:7) with
  no permission event. Inconsistent with `job stop`. Suggest `ctx.ask({permission:
  "cron", patterns: ["create"]})` so file-based rules can govern it;
  design-permissions.md has no job/cron entries at all (doc gap).
- **Durability asymmetry:** jobs are restart-durable (SQLite, reclaim, redelivery);
  cron schedules are in-memory and die with the process (admitted in the tool
  description, tool/cron.ts:27), plus recurring entries silently expire after 7
  days (cron-runtime.ts:6,160-163). For a restart-cycled agent microservice (the
  REFRESH drain-then-exit flow is a designed feature, design-orchestrator.md) this
  makes cron near-useless across recycles. Candidate: persist cron entries next to
  jobs.
- **Naming trap: three "background job" things now coexist.**
  (1) `packages/core/src/background-job.ts` `BackgroundJob` — in-memory task/
  subagent registry; (2) `packages/opencode/src/background/job.ts` — instance-scoped
  wrapper of (1) (note: its `import { BackgroundJob as CoreBackgroundJob }` violates
  the AGENTS.md no-alias rule); (3) `SessionJob*` (store/runtime) + the `job` TOOL +
  `bash background:true`. `run-state.ts` has `cancelBackgroundJobs` (cancels (1))
  while `SessionJobRuntime.cancelSession` cancels (3). CHANGELOG says "no naming
  collision" — true for identifiers, false for humans. Cheap mitigation: a
  paragraph in AGENTS.md or a rename of (1) to TaskRegistry when V2 touches it.
- **Stale docs the port obsoleted:** index.md:73 still says the port is "NOT YET
  merged to dev" (it merged as `8b2b7c250`/`9d098f4e8`); lmctl-polling-findings.md
  §1 claims "NO scheduler ... cron: NONE re-invoke the model" (cron-runtime now
  does exactly that); index.md:47 bootstrap says bun is at
  `/tmp/opencode/.bun/bin/bun` (this host: `~/.bun/bin/bun`).

## 6. Test + typecheck status (run 2026-08-21 on this host)

- `packages/core`: `bun test --timeout 30000 --only-failures` → **1109 pass / 0
  fail** (145 files, ~78s).
- `packages/opencode`: full suite run in progress at write time; result recorded in
  the index task-log entry. Ported job/cron unit suites + the new mock-LLM
  integration test are in-tree (test/session/job-runtime.test.ts, job-store.test.ts,
  cron-runtime.test.ts, notification-retry.test.ts, prompt.test.ts:1098-1189).
- `bun run typecheck`: clean in both packages.
- Coverage gap worth closing: nothing asserts the GLOBAL no-two-turns invariant
  (the §2 test sketch); all existing serialization tests are per-feature.

## 7. Half-finished / flagged-incomplete inventory (highest value first)

1. §3 missing claim-liveness port (changelog already claims it — correctness bug).
2. Live-ollama handoff BUILT-BUT-UNTESTED (provider-ollama.md:6,89 — needs a host
   with ollama; the whole config-free provider + chat-only path has never made a
   real HTTP round-trip).
3. Profiles follow-ups (model-profiles.md:85-90): per-model auto-select (qwen* →
   lean) and config-defined `provision` are schema-wired but inert; V2
   `ToolRegistry.materialize()` seam untouched.
4. Non-interactive API-key login for `providers login` (index.md:85, config-cli.md).
5. Branding leftovers: ASCII logo, `opencode-<plat>` package names, publish.ts,
   postinstall.mjs (index.md:83-84).
6. `contract-session-metrics.md:142`: cost still derived, not persisted at
   write-time.
7. design-cli-only.md:79 OPEN: retire `packages/cli` (second TUI embedder) + embedded
   web UI? Never decided.
8. Operator's "hard 5-minute timeout" report still unreproduced (index.md:76-78).

## 8. "app-host" resolved

design-orchestrator.md:293's "USE THIS HARNESS for future integration tests
(permission, app-host)" refers to the NEXT-section item 2 a few lines below
(:305): "lmcode AS A REST SERVER TO HOST APPLICATIONS (not just a coding agent) —
generalize the microservice to host arbitrary apps/agents. Needs a design
conversation." Floated, never designed or committed. It is a direction candidate,
not an existing component.

## 9. Proposed next directions (prioritized)

1. **Gate the notification/cron turn origins (close §2).** Direct pillar-3
   violation; the fix is bounded (two wrap sites in prompt.ts + one conformance
   test). Risk: lock-ordering mistake if gated inside the runner instead of the
   caller (see sketch); drain semantics must stay 503-then-redeliver.
2. **Port `eaa7ccbf6` (§3) + correct CHANGELOG.** Small, mechanical, removes a real
   duplicate-turn race and a false doc claim. Risk: migration ordering vs local DBs
   — the sibling migration file carries its own timestamp, should apply cleanly.
3. **Unify shutdown (§4).** serve SIGTERM must run `SessionJobRuntime.shutdown()`
   and halt the cron ticker post-drain. Small. Risk: 10s job-kill window added to
   drain; cap total with the existing DRAIN_TIMEOUT.
4. **Durable cron + `cron` permission ask (§5).** Persist schedules in SQLite
   (mirror job-store patterns incl. liveness-checked ownership) so REFRESH recycles
   don't silently drop an agent's schedules; add the ask so file-based rules can
   deny scheduling. Medium. Risk: multi-process double-fire — needs the same
   claim/fence discipline jobs already have; do it as a port-quality slice, not a
   quick hack.
5. **Sequential-queue conformance test.** Mock-harness integration test asserting no
   two LLM turns ever overlap process-wide (HTTP × notification × cron). Cheap
   insurance for every future port from the (gate-less) sibling fork. Small.
6. **Live-ollama validation (§7.2).** Close the oldest BUILT-BUT-UNTESTED flag;
   unlocks the lean-profile/weak-model story end-to-end (lean profile exists
   precisely for qwen2.5-class models). Small, but requires an ollama host.
7. **Job/cron observability in the CLI + session-metrics contract.** `lmplayer
   session jobs <id> --json` (list/status/output paths) and job counts in
   `session-metrics/v1` (contract-session-metrics.md is explicitly versioned for
   extension). Fits the agent-drives-CLI purpose: today jobs are visible only to
   the LLM via the `job` tool, not to the operator/lmctl. Small-medium.
8. **Profiles phase 2 (§7.3).** Per-model auto-select + config-defined provision:
   makes weak-model support config-driven instead of flag-driven; schema is already
   wired. Medium. Risk: silent tool loss if auto-select misfires — keep explicit
   `--agent` override precedence.
9. **app-host design conversation (§8).** Don't build; schedule the operator
   discussion the doc asks for. The §2/§4 fixes are prerequisites anyway (a
   multi-app host multiplies sessions, which multiplies today's cross-session gate
   bypass).
10. **Doc hygiene pass on durable-memory.** Fix the four §5 stale claims; memory is
    the team's boot context — false claims there compound (this review found two
    doc-vs-code lies, §3 and index.md:73).

## Uncertainties / second-opinion requests

- Whether the operator considers cross-session concurrency a pillar violation AT
  ALL, given "single-user": if the intended meaning is "one HUMAN/API request at a
  time" and agent-internal turns are exempt (like subagents are), §2 shrinks from
  bug to documentation update. The execution-gate comment says "across the whole
  server", so I treated it as the spec. Operator should rule.
- Cron `wakeIfIdle` semantics after gating: a cron turn would then run whenever the
  gate frees even if the operator is mid-conversation elsewhere; if crons should be
  strictly lowest-priority, a "gate idle AND no queued waiters" check is a further
  refinement I did not design.
- I did not deep-review the upstream-refresh merge itself (586 commits,
  `bbb19361b`) beyond confirming suites/typecheck; conflicts were resolved before
  my review.
