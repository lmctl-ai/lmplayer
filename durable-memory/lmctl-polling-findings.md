# How opencode/lmplayer drives the LLM: turn-loop + polling model + subprocess lifecycle (code + tested)

**From:** lmcode fleet (meta-lead). Precise, evidence-backed answer to "how does the agent get woken / poll?"
file:line refs + an empirical subprocess-lifecycle test. Repo: opencode-derived lmplayer.

**UPDATE 2026-08-21:** §1's "no scheduler" claim is now stale. The session-job-port
merge added `SessionCronRuntime` (`session/cron-runtime.ts`), an in-memory
30-second tick timer that DOES re-invoke the model on a schedule (a `cron` tool
lets an agent create recurring/one-shot self-prompts). The rest of this doc
(turn-loop mechanics, subprocess lifecycle) is unaffected. See
`review-2026-08-20-codebase-and-direction.md` §2 for how cron-fired turns
interact with the execution gate this doc also describes.

## 1. There is NO scheduler that polls/wakes the LLM. A "turn" is purely prompt-driven.
- A run starts ONLY when a new prompt/message arrives: `prompt()` -> `state.ensureRunning(sessionID, ...,
  runLoop(sessionID))` (session/prompt.ts:1053,1360). HTTP entry: handlers/session.ts:403 (`prompt`) / :414,428
  (`promptAsync`, fire-and-forget, wrapped in the execution-gate `serialize`).
- The turn is a synchronous loop: `while(true)` (prompt.ts:1089) -> call model -> execute tool calls INLINE and
  awaited (processor.ts settles each tool result :183/201/255) -> feed back -> repeat. It BREAKS only when the
  model returns a final message with NO tool calls (prompt.ts:1112-1131). Then the session is idle.
- Grep of session/ + core/session/ for setInterval|setTimeout|cron|poll|schedule: NONE re-invoke the model. The
  only `wake` primitives are V2 core (execution.ts:15, run-coordinator.ts:81) and they trigger a DRAIN of durable
  queued work, not a timed poll — and are not on the live HTTP path.

## 2. So "the agent polling" is really two things
- WITHIN one turn: the agent issues a bash tool call like `sleep 30 && check-log`; the loop runs it synchronously
  (the model blocks on the tool result), then continues. Bounded — the turn must end, and the bash tool has a
  timeout.
- ACROSS turns: after a final response the session is idle and the agent is DORMANT. Nothing re-invokes it. The
  next "poll" happens only when a NEW prompt arrives — i.e. when the operator (or another driver) sends another
  message. The operator is effectively the wake signal; the "frequency" is how often you re-prompt, not something
  opencode schedules.
- Consequence: fire-and-forget background work gets NO completion callback. The agent never learns a job finished
  unless it is re-prompted and chooses to check. Matches operator experience: prompt -> agent delegates -> agent
  idle -> never wakes unless asked again. (Fine if members autopilot; otherwise members return quickly and the
  meta-lead never issues the next order until re-prompted.)

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
