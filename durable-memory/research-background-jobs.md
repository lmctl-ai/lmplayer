# Background Jobs And Wake-On-Completion Research

Research date: 2026-07-06

## Executive Summary

OpenCode has two distinct "background" mechanisms that matter for wake-on-completion:

- In-process background subagents use `BackgroundJob.Service` plus `TaskTool` notification. When a child subagent finishes, `task.ts` waits on the process-local registry and injects a synthetic prompt into the parent session, which wakes the parent in-process.
- External async session execution uses `POST /session/:id/prompt_async` plus the live `/event` SSE stream. The HTTP caller is not called back; a resident client must hold `GET /event` open and react to `message.updated`, `message.part.updated`, `session.status` idle, and `session.error` events.

The current detached `lmplayer run` subprocess pattern does not wake the original caller because it creates a separate OS process and no in-process parent/child relationship, no shared `BackgroundJob` registry waiter, no synthetic injection back to a parent session, and no persistent `/event` subscription in the caller.

## 1. Background Job Registry

The core registry lives in `packages/core/src/background-job.ts` and is an in-memory process-local service.

### Data Model

- A public job snapshot is `BackgroundJob.Info`: `id`, `type`, optional `title`, `status`, timestamps, optional `output`, `error`, and metadata (`packages/core/src/background-job.ts:7-19`).
- Runtime state is `Active`: public `info`, completion `done` deferred, closeable `scope`, identity `token`, pending run count, sequence counters, latest successful `output`, serialized `tail` deferred, promotion `promoted` deferred, and optional `onPromote` effect (`packages/core/src/background-job.ts:21-32`).
- The registry state is just a `SynchronizedRef<Map<string, Active>>` plus a parent `Scope` (`packages/core/src/background-job.ts:34-37`).

### Process-Local And Non-Durable

The registry explicitly documents its semantics: it is one scoped, process-local registry, entries are intentionally not durable, and process restart or owner-scope closure loses status and interrupts live work. Durable observation, restart recovery, and remote workers require a separate durable ownership slice (`packages/core/src/background-job.ts:113-119`).

Consequences:

- `BackgroundJob` state is not stored in the database.
- After restart there is no job list, no completion result, and no live waiter.
- A different OS process has a different registry even if it points at the same project/database.

### Lifecycle API

The service interface exposes `list`, `get`, `start`, `extend`, `wait`, `waitForPromotion`, `promote`, and `cancel` (`packages/core/src/background-job.ts:88-97`).

`start(input)`:

- Accepts optional `id`, `type`, optional `title`, `metadata`, optional `onPromote`, and a `run: Effect.Effect<string, unknown>` that produces the job output (`packages/core/src/background-job.ts:64-71`).
- If a running job already exists for the id, it returns that existing snapshot rather than starting another run (`packages/core/src/background-job.ts:213-216`).
- Otherwise it creates a new scoped job with `pending: 1`, `next: 1`, a `tail` deferred, and an optional `onPromote` hook (`packages/core/src/background-job.ts:217-237`).
- It forks the restored `run` effect inside the job scope and ensures the first `tail` deferred completes when the run exits (`packages/core/src/background-job.ts:243-250`).

`settle(...)`:

- Updates the job on run completion, computes `completed`, `cancelled`, or `error`, records `completed_at`, latest successful output, or squashed error text (`packages/core/src/background-job.ts:126-165`).
- Completion only finalizes when pending reaches zero; multiple successful extensions can update the final output by sequence (`packages/core/src/background-job.ts:138-145`).
- It completes the `done` deferred and closes the job scope (`packages/core/src/background-job.ts:166-169`).

`extend(input)`:

- Adds another run to an existing running job and returns `false` if there is no running job (`packages/core/src/background-job.ts:256-277`).
- The extension waits for the previous `tail` before running, so extensions are serialized in order (`packages/core/src/background-job.ts:277-285`).
- It increments `pending` and `next`, uses the same token and scope, and advances the `tail` (`packages/core/src/background-job.ts:260-273`).

`wait(input)`:

- If no job exists, returns `{ timedOut: false }` with no info (`packages/core/src/background-job.ts:292-294`).
- If already settled, returns the snapshot immediately (`packages/core/src/background-job.ts:295`).
- Without timeout, awaits `job.done` (`packages/core/src/background-job.ts:296`).
- With timeout, returns either completed info or a running snapshot with `timedOut: true` (`packages/core/src/background-job.ts:297-300`).

`waitForPromotion(id)`:

- If no running job exists, it never completes (`packages/core/src/background-job.ts:303-305`).
- If the job is already marked `metadata.background === true`, it returns immediately (`packages/core/src/background-job.ts:306`).
- Otherwise it awaits the `promoted` deferred (`packages/core/src/background-job.ts:307`).

`promote(id)`:

- Only applies to running jobs (`packages/core/src/background-job.ts:310-317`).
- Marks metadata with `background: true`, clears `onPromote`, succeeds the `promoted` deferred, and then runs the saved `onPromote` hook if present (`packages/core/src/background-job.ts:318-334`).

`cancel(id)`:

- Sets a running job to `cancelled`, records `completed_at`, completes `done`, and closes the job scope (`packages/core/src/background-job.ts:337-357`).

### Instance Wrapper

`packages/opencode/src/background/job.ts` wraps the core registry for the opencode application.

- It re-exports core types and `Service` (`packages/opencode/src/background/job.ts:6-15`).
- The layer keeps the legacy service instance-scoped while sharing the core registry implementation (`packages/opencode/src/background/job.ts:17-23`).
- Every method calls `InstanceState.useEffect(state, ...)`, so each instance/directory gets its own cached core registry (`packages/opencode/src/background/job.ts:21-31`).
- The node is a `LayerNode` for `CoreBackgroundJob.Service` with no deps (`packages/opencode/src/background/job.ts:37`).

## 2. Task / Subagent Tool

`packages/opencode/src/tool/task.ts` is the main producer of managed background work.

### Tool Contract

- `background` is an optional boolean parameter: "Run the agent in the background. You will be notified when it completes" (`packages/opencode/src/tool/task.ts:56-62`).
- The tool description adds background-mode guidance when `experimentalBackgroundSubagents` is enabled (`packages/opencode/src/tool/task.ts:25-35`, `packages/opencode/src/tool/task.ts:336-341`).
- If `background=true` is requested but the flag is disabled, execution fails (`packages/opencode/src/tool/task.ts:96-102`).

### Child Session Creation

- The tool resolves the requested subagent (`packages/opencode/src/tool/task.ts:116-119`).
- It optionally resumes an existing `task_id`, otherwise creates a new child session with `parentID: ctx.sessionID`, a subagent title, agent name, and derived permissions (`packages/opencode/src/tool/task.ts:121-158`).
- It reads the parent assistant message to preserve the model variant and derive the child model (`packages/opencode/src/tool/task.ts:160-170`).
- Metadata records `parentSessionId`, child `sessionId`, model, and optionally `background: true` (`packages/opencode/src/tool/task.ts:171-176`).

### Running The Child

The child work is `runTask`:

- Resolve the child prompt parts from the prompt template (`packages/opencode/src/tool/task.ts:186-188`).
- Call `ops.prompt(...)` with a new message id, child session id, selected model, variant, agent, and parts (`packages/opencode/src/tool/task.ts:188-198`).
- Return the last text part from the child result as the task output (`packages/opencode/src/tool/task.ts:199`).

The important detail is that `ops.prompt` is not an HTTP call. It is a `TaskPromptOps` callback supplied in tool context (`packages/opencode/src/tool/task.ts:18-22`, `packages/opencode/src/tool/task.ts:183-184`). The subagent re-enters session execution inside the same process, so it shares the same `BackgroundJob` registry, Effect scope, and event bus.

### Background Job Use

- If a job already exists for the child session id, `background.extend({ id: nextSession.id, run: runTask() })` queues additional context onto the running job and returns a "Background task updated" result (`packages/opencode/src/tool/task.ts:242-257`).
- Otherwise `background.start(...)` starts a job with `id: nextSession.id`, `type: "task"`, title, metadata, `onPromote`, and `run: runTask().pipe(Effect.onInterrupt(() => ops.cancel(nextSession.id)))` (`packages/opencode/src/tool/task.ts:259-272`).
- In explicit background mode, it immediately forks notification and returns a running `<task ... state="running">` result to the model (`packages/opencode/src/tool/task.ts:274-293`).
- In foreground mode, it races `background.wait(...)` against `background.waitForPromotion(...)`. If promoted while still running, it returns the same background-running result; otherwise it returns the completed output or fails on error/cancel (`packages/opencode/src/tool/task.ts:303-321`).
- On interruption of foreground waiting, it cancels both the child prompt and the background job (`packages/opencode/src/tool/task.ts:322-325`).

### Wake-On-Completion: inject() / notify()

The in-process wake path is explicit:

- `inject(state, text)` reloads the parent session and calls `ops.prompt(...)` against the parent `ctx.sessionID` (`packages/opencode/src/tool/task.ts:202-211`).
- The prompt part is synthetic text (`synthetic: true`) containing a rendered `<task id="child" state="completed|error">` message with a summary and result/error text (`packages/opencode/src/tool/task.ts:212-225`).
- The parent prompt injection is forked into the current scope and ignored for the current tool result (`packages/opencode/src/tool/task.ts:227-228`).
- `notify(jobID)` waits for the job completion using `background.wait({ id: jobID })`; on completed status it injects a completed synthetic result, on error it injects an error synthetic result, otherwise it does nothing (`packages/opencode/src/tool/task.ts:231-239`).
- `notify(info.id)` runs immediately for explicit background mode (`packages/opencode/src/tool/task.ts:291-293`).
- For a foreground task that is later promoted, `onPromote` updates tool metadata and calls `notify(nextSession.id)` (`packages/opencode/src/tool/task.ts:264-270`).

That is the key "wake" behavior: child completion is not merely observable; completion causes a new synthetic parent prompt. The parent session is woken because `ops.prompt` admits a new prompt into the parent session's execution path.

## 3. Event System

### EventV2 PubSub

`packages/core/src/event.ts` implements the live event bus and durable event store.

- `EventV2.Interface` exposes `publish`, typed `subscribe`, `all`, durable aggregate stream, legacy `listen`, projectors, replay, removal, and aggregate claiming (`packages/core/src/event.ts:126-148`).
- The layer holds an unbounded all-events PubSub, typed PubSubs, durable aggregate wake PubSubs, projectors, and legacy listeners (`packages/core/src/event.ts:170-182`).
- Durable events are committed to `EventSequenceTable` and `EventTable` under a transaction (`packages/core/src/event.ts:237-349`).
- After a durable commit, aggregate-specific durable subscribers are woken by publishing to a per-aggregate PubSub (`packages/core/src/event.ts:354-360`).
- `publishEvent` notifies live listeners and PubSubs after durable commit, or immediately for non-durable events (`packages/core/src/event.ts:369-395`).
- `notify` invokes legacy listeners, publishes to the typed PubSub, and publishes to the all-events PubSub (`packages/core/src/event.ts:406-416`).
- `all()` is a live stream from `pubsub.all` (`packages/core/src/event.ts:539`).
- `listen(listener)` eagerly registers a callback and returns an unsubscribe effect (`packages/core/src/event.ts:606-613`).
- `durable({ aggregateID, after })` reads historical durable events and then waits on aggregate-specific wakes to read new events (`packages/core/src/event.ts:565-603`).

### Bridge To Legacy Global Bus And Location

`packages/opencode/src/event-v2-bridge.ts` wraps `EventV2.Service`.

- `publish` adds instance location data when no explicit location is supplied, including directory, workspace id, and project info (`packages/opencode/src/event-v2-bridge.ts:19-33`).
- It also registers an `events.listen` listener that emits every event to `GlobalBus` with `payload: { id, type, properties: event.data }` (`packages/opencode/src/event-v2-bridge.ts:35-44`).
- Durable events additionally emit a `sync` payload with versioned type, seq, aggregate id, and data (`packages/opencode/src/event-v2-bridge.ts:45-60`).

### Completion-Related Events

There is no public `background-job.completed` event emitted by `BackgroundJob`. The registry completes waiters in memory (`packages/core/src/background-job.ts:166-170`) but does not publish EventV2 events.

Session and message completion are observed through session events:

- `message.updated` is defined as a durable V1 session event carrying `sessionID` and message `info` (`packages/schema/src/v1/session.ts:596-603`).
- `message.part.updated` is defined with `sessionID`, part, and time (`packages/schema/src/v1/session.ts:612-620`).
- Session status uses `session.status` with `idle`, `retry`, or `busy` status (`packages/schema/src/session-status-event.ts:9-41`).
- Deprecated `session.idle` is also defined (`packages/schema/src/session-status-event.ts:43-49`).
- `SessionStatus.set` publishes `session.status`; when status is idle it also publishes deprecated `session.idle` and removes in-memory status (`packages/opencode/src/session/status.ts:39-45`).
- `SessionRunState` marks a runner busy on start and idle in `onIdle`, so a completed prompt emits `session.status` idle (`packages/opencode/src/session/run-state.ts:59-65`).
- `Session.updateMessage` publishes `SessionV1.Event.MessageUpdated` (`packages/opencode/src/session/session.ts:644-648`).
- `Session.updatePart` publishes `SessionV1.Event.PartUpdated` (`packages/opencode/src/session/session.ts:650-658`).
- `Session.updatePartDelta` publishes `message.part.delta` (`packages/opencode/src/session/session.ts:922-930`).

LLM provider step-finish is not itself an EventV2 event. The core runner records a `step-finish` settlement internally when the LLM stream emits it (`packages/core/src/session/runner/publish-llm-event.ts:396-401`). In legacy session projection this becomes a message part update that observers see through `message.part.updated`.

## 4. HTTP Surface For Background + Events

### Promote Synchronous Subagents To Background

The experimental endpoint is `POST /experimental/session/:sessionID/background` (`packages/opencode/src/server/routes/instance/httpapi/groups/experimental.ts:90-101`, `packages/opencode/src/server/routes/instance/httpapi/groups/experimental.ts:235-247`).

Handler behavior:

- If background subagents are disabled, return false (`packages/opencode/src/server/routes/instance/httpapi/handlers/experimental.ts:158-162`).
- List process-local background jobs and select running `type === "task"` jobs whose `metadata.parentSessionId` matches the session and whose metadata is not already background (`packages/opencode/src/server/routes/instance/httpapi/handlers/experimental.ts:162-168`).
- Promote all matches concurrently using `background.promote(job.id)` and return whether anything was promoted (`packages/opencode/src/server/routes/instance/httpapi/handlers/experimental.ts:169-170`).

Promotion triggers the job's `onPromote` hook (`packages/core/src/background-job.ts:332-333`), and for task-tool jobs that hook starts `notify(...)` (`packages/opencode/src/tool/task.ts:264-270`).

### promptAsync Fire-And-Forget

The async prompt route is `POST /session/:sessionID/prompt_async` (`packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:120-124`, `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:382-395`).

Handler behavior:

- Require the session (`packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:414-418`).
- If draining, return 503 immediately (`packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:419-425`).
- Fork `serialize(promptSvc.prompt(...))` into the server scope and return `204 No Content` (`packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:428-445`).
- Genuine post-admission failures are logged and published as `session.error` (`packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:434-441`).

This route intentionally does not hold the HTTP response open until completion. Completion notification is through events.

### SSE Event Stream

The event endpoint is `GET /event` with `text/event-stream` response (`packages/opencode/src/server/routes/instance/httpapi/groups/event.ts:7-17`).

Handler behavior:

- `eventResponse` reads instance context and workspace id (`packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts:25-29`).
- It eagerly registers an `events.listen` callback into an unbounded queue before starting the response body so no events after registration are lost during body startup (`packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts:29-33`).
- It filters events to the current instance directory and workspace (`packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts:34-40`).
- It maps EventV2 payloads to `{ id, type, properties }` (`packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts:40`).
- It merges server-disposal events and heartbeat events, emits an initial `server.connected`, SSE-encodes each event as `event: message` with JSON data, and sets SSE/no-buffering headers (`packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts:59-85`).
- The handler closes over `EventV2Bridge.Service` (`packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts:89-98`).

An external driver can therefore be woken live by:

- Keeping `GET /event` open on a resident `serve` process.
- Starting work with `POST /session/:id/prompt_async` or another execution endpoint.
- Reacting when the target session emits `message.updated`, terminal `message.part.updated` such as completed text/tool/step-finish parts, `session.error`, or `session.status` with `status.type === "idle"`.

The `lmplayer run` non-interactive implementation demonstrates this pattern: it subscribes to events (`packages/opencode/src/cli/cmd/run.ts:817-818`), processes the event stream (`packages/opencode/src/cli/cmd/run.ts:682-686`), prints message and part updates (`packages/opencode/src/cli/cmd/run.ts:687-762`), captures `session.error` (`packages/opencode/src/cli/cmd/run.ts:764-774`), and exits its loop on `session.status` idle for the active session (`packages/opencode/src/cli/cmd/run.ts:776-782`).

The newer run stream transport uses the same shape: it builds a long-lived event-stream watch (`packages/opencode/src/cli/cmd/run/stream.transport.ts:1-15`), consumes `events.stream` (`packages/opencode/src/cli/cmd/run/stream.transport.ts:1127-1184`), sends prompt turns via `session.promptAsync` (`packages/opencode/src/cli/cmd/run/stream.transport.ts:1321-1325`), and waits until its deferred turn completion is resolved (`packages/opencode/src/cli/cmd/run/stream.transport.ts:1364-1376`).

## 5. Why Detached `lmplayer run` Does Not Wake The Caller

The current pattern described here fires background work as a separate `lmplayer run` subprocess using `setsid`/detachment and then polls. That does not map to either wake path above.

Reasons:

- It is a separate OS process, so it has its own Effect runtime, scopes, `BackgroundJob` map, PubSubs, listeners, and server/client lifecycle.
- `BackgroundJob` is process-local and non-durable, so no parent process can wait on the child process's registry entry (`packages/core/src/background-job.ts:113-119`).
- The task-tool injection path requires an in-process parent tool call with shared `TaskPromptOps`, shared registry, and `notify()` fiber. A detached subprocess does not have the parent `ctx.sessionID`, `ctx.messageID`, `ops.prompt`, or parent Effect scope needed by `inject()` (`packages/opencode/src/tool/task.ts:202-239`).
- `prompt_async` returns 204 after admission/forking and does not keep a callback channel to the request caller (`packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:428-445`).
- If the original caller is not holding `/event` open, it has no live subscription to `message.updated`, `message.part.updated`, `session.error`, or `session.status idle` events (`packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts:25-85`).
- Database writes or durable events can be polled later, but they are not a wake signal to a process that is neither subscribed nor in the same runtime.

Contrast:

- In-process task-tool subagent: parent starts child through `ops.prompt`, child result settles `BackgroundJob`, `notify()` waits in the same process, and `inject()` calls `ops.prompt` on the parent with a synthetic result (`packages/opencode/src/tool/task.ts:186-239`). This wakes the parent.
- Resident driver over `serve`: one long-lived process owns execution, the driver holds `/event` SSE, starts jobs with async endpoints, and reacts to streamed session events. This wakes the driver, even though the original `prompt_async` HTTP response is fire-and-forget.

## 6. What Enables Wake-On-Completion

### Existing Option A: In-Process Subagents

Use the `task` tool in background mode inside a parent session.

- Start child as a `BackgroundJob` keyed by child session id (`packages/opencode/src/tool/task.ts:259-272`).
- Return immediately to the model with a running task result (`packages/opencode/src/tool/task.ts:291-293`).
- `notify()` waits for completion and injects a synthetic completed/error prompt into the parent (`packages/opencode/src/tool/task.ts:202-239`).

This is the only current mechanism that wakes the parent session itself by injecting a new parent input.

### Existing Option B: Resident Server + SSE Driver

Run a resident `serve` process and keep a client connected to `/event`.

- Start work through `prompt_async` (`packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:414-445`).
- Observe events through `GET /event` (`packages/opencode/src/server/routes/instance/httpapi/groups/event.ts:14-17`, `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts:68-85`).
- Treat `session.status` idle, relevant `message.updated`/`message.part.updated`, and `session.error` as completion/progress notifications. This is the pattern used by `run.ts` (`packages/opencode/src/cli/cmd/run.ts:817-824`) and its event loop (`packages/opencode/src/cli/cmd/run.ts:682-782`).

This wakes the driver, not necessarily an LLM parent session, unless the driver then chooses to prompt/inject into a lead session.

### Missing For A True Resident Lead Loop

A true resident lead loop would be one process that owns:

- Operator IO.
- N background session launches.
- A durable/live registry of outstanding work.
- A persistent event subscription.
- Logic to react to completion events by resuming the lead/operator loop or injecting results into a lead session.

Gaps and constraints in current code:

- `BackgroundJob` is non-durable and process-local, so it cannot be the durable multi-process job registry (`packages/core/src/background-job.ts:113-119`).
- There is no generic HTTP background-job observation endpoint; the core bash tool explicitly calls this out as future work after durable status, restart recovery, and authorization are defined (`packages/core/src/tool/bash.ts:71-74`).
- HTTP execution is serialized by a process-global FIFO semaphore with one permit. Only one agent run through HTTP prompt/command/init/summarize/shell/import executes at a time across the server (`packages/opencode/src/server/execution-gate.ts:4-16`).
- The gate is intentionally only at the HTTP handler boundary; subagents re-enter in-process via `ops.prompt` and bypass it to avoid deadlock (`packages/opencode/src/server/execution-gate.ts:10-14`).
- `prompt_async` queues/runs under this same gate inside the forked effect, not at request-return time (`packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:425-428`). This means HTTP fan-out is live-notifiable but still serialized by the server gate.

Shortest path to a resident lead loop that does wake:

1. Keep one `serve` process running.
2. Keep one driver connection subscribed to `GET /event` for the target directory/workspace.
3. Launch background work with `prompt_async` sessions or in-process task-tool background subagents, recording session ids/job ids in the driver.
4. On `message.updated`, `message.part.updated`, `session.error`, or `session.status idle`, match by session id and update the driver's outstanding-work table.
5. If the lead session should be woken, have the resident driver explicitly prompt/inject a synthetic result into the lead session, analogous to `TaskTool.injectBackgroundResult`.

## Concise Summary

OpenCode supports background work in two ways. `BackgroundJob` is an in-memory, scoped, process-local registry for in-process jobs, mostly used by the `task` subagent tool. It supports start/extend/wait/promotion/cancel but is non-durable and disappears on restart. The `task` tool provides the strongest wake-on-completion path: it waits for the child job and injects a synthetic completed/error message into the parent session via `ops.prompt`, which wakes the parent.

For external drivers, completion notification is event-stream based. `prompt_async` returns immediately and forks the run; a driver must hold `GET /event` SSE open and react to session events such as `message.updated`, `message.part.updated`, `session.error`, and `session.status` idle.

Detached `lmplayer run` subprocesses do not wake the original caller because they are separate OS processes with separate in-memory registries and event listeners, and because the caller has neither an in-process `inject()` path nor a persistent SSE subscription. Polling works because durable session/message state exists; waking does not because no live channel is held.

The shortest practical route to resident lead mode is a single resident driver over `serve`: keep `/event` open, launch work with async session endpoints or in-process subagents, track outstanding sessions, and resume or inject into the lead when completion events arrive. Product gaps remain for durable background-job status, restart recovery, remote job observation, and true concurrent HTTP agent execution under the current process-global execution gate.
