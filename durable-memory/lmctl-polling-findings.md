# How opencode/lmplayer drives the LLM: turn-loop + polling model + subprocess lifecycle (code + tested)

**From:** lmcode fleet (meta-lead). Precise, evidence-backed answer to "how does the agent get woken / poll?"
file:line refs + an empirical subprocess-lifecycle test. Repo: opencode-derived lmplayer.

**UPDATE (Current State):** The session-job-port and sequential-gate fixes merged
`SessionCronRuntime` (`session/cron-runtime.ts`) and `SessionJobRuntime`/`SessionJobStore`
(`session/job-runtime.ts`, `session/job-store.ts`). The model CAN now be re-invoked on a
schedule via the `cron` tool and receives completion notifications when background jobs finish.
All turn origins (HTTP prompts, job notifications, and cron turns) are strictly serialized through
the process-global execution gate (`execution-gate.ts`), ensuring single-user turn serialization.

## 1. How turns are driven
- Primary run entry: prompt/message arrives via HTTP: `SessionHttpApi.prompt` / `promptAsync`,
  wrapped in `executionGate.serialize`.
- Notification run entry: background job completes -> `SessionJobNotificationRetry` schedules an
  attempt wrapped in `gateSerialize` -> synthesizes user notification message and executes prompt loop.
- Cron run entry: in-memory 30s tick timer (`SessionCronRuntime`) claims due entries and executes
  via `gateSerialize` -> synthesizes user prompt message and executes prompt loop.
- The turn loop is a synchronous loop: call model -> execute tools inline -> repeat until final
  assistant message with no tool calls.

## 2. Across-turn behavior
- When all sessions are idle, the agent process is dormant, awaiting HTTP requests, job completion, or cron tick.
- Background tasks: with `bash background:true` / `job` tool, tasks run detached under `SessionJobRuntime`.
  On completion, the agent receives an automatic completion notification turn delivered through the sequential gate.
- Scheduled tasks: with `cron`, agents can register recurring or one-shot self-prompts that re-awaken
  the session through the sequential gate.

## 3. TESTED: one-shot `run` + backgrounded subprocesses — does opencode wait? does exit kill them?
Test: a one-shot `lmplayer run` whose task spawns two ~50s jobs (one `setsid`-detached, one plain `&`) then
replies DONE without waiting. Measured:
- The one-shot **exited in ~10s** while the jobs run 50s => **opencode does NOT wait for backgrounded subprocesses;
  it exits as soon as the turn goes idle.**
- **24s after the one-shot exited, BOTH jobs were still alive and had advanced to tick 20/25** => **opencode's
  exit does NOT abort them.** Unlike a login shell SIGHUP-killing its process group, both the `setsid`-detached AND
  the plain `&` child survived (reparented to init) and ran to completion.
- Net: in one-shot mode the WORK survives opencode's exit — but there is still no wake/notify. Jobs finish, write
  their logs, and sit idle. (In TUI/serve mode the host process stays alive, so the session persists, but the
  agent is still idle until re-prompted.)

## 4. Wake mechanisms that DO exist in code (but are NOT wired to external fire-and-forget)
- In-process subagent (tool/task.ts): a background subagent injects its result back into the PARENT's active turn
  (inject/notify) — real wake, but in-process + non-durable + only within the parent run.
- Resident `serve` + GET /event SSE (groups/event.ts): a client holding the event stream can `promptAsync` N
  sessions and react to `message.updated`/idle live (this is exactly run.ts's own loop). Nothing external subscribes
  today.
- MISSING for a durable "fire -> woken on finish/error": the execution-gate semaphore(1) serializes HTTP runs
  (server/execution-gate.ts); BackgroundJob is non-durable (core/background-job.ts).

## 5. What we're building (per operator)
Enhance lmplayer with durable BACKGROUND SUBMISSION: fire unblocked, lmplayer keeps the subprocess alive to
completion, and on finish/error it NOTIFIES/WAKES the submitting session (injects a completion prompt) so a new
turn is triggered by the completion — not by the operator re-asking. Same "resident lead" capability lmctl asked
for; grounded in the mechanisms above. Full code map in our durable-memory/research-background-jobs.md.
