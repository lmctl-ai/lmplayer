import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Runner } from "@/effect/runner"
import { Effect, Latch, Scope } from "effect"
import { SessionJobRuntime } from "@/session/job-runtime"
import { MAX_JOB_OUTPUT, SessionJobStore } from "@/session/job-store"
import { SessionID } from "@/session/schema"
import { readOutput } from "@/tool/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([SessionJobRuntime.node, SessionJobStore.node, Database.node, EventV2Bridge.node]),
    [[Database.node, Database.layerFromPath(":memory:")]],
  ),
)

const setup = Effect.fn("SessionJobRuntimeTest.setup")(function* () {
  const { db } = yield* Database.Service
  const suffix = crypto.randomUUID()
  const projectID = ProjectV2.ID.make(`project-${suffix}`)
  const sessionID = SessionID.make(`ses_${suffix}`)
  const directory = AbsolutePath.make(`/tmp/${suffix}`)
  yield* db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: directory, sandboxes: [], time_created: Date.now(), time_updated: Date.now() })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: projectID,
      slug: suffix,
      directory,
      title: "job runtime test",
      version: "test",
      time_created: Date.now(),
      time_updated: Date.now(),
    })
    .run()
    .pipe(Effect.orDie)
  return sessionID
})

describe("SessionJobRuntime", () => {
  it.live(
    "flushes valid UTF-8 before recording terminal state and uses code-point-safe offsets",
    Effect.gen(function* () {
      const runtime = yield* SessionJobRuntime.Service
      const store = yield* SessionJobStore.Service
      const sessionID = yield* setup()
      const submitted = yield* runtime.submit({
        sessionID,
        assistantMessageID: "msg_assistant",
        toolCallID: "call-output",
        command: "printf 'A€B'",
        cwd: "/tmp",
        shell: "/bin/sh",
        timeout: 10_000,
        env: process.env,
      })
      const row = yield* pollWithTimeout(
        store
          .get(sessionID, submitted.job.id)
          .pipe(Effect.map((value) => (value.time_completed === null ? undefined : value))),
        "background job did not complete",
      )
      expect(row.status).toBe("completed")
      expect(row.output_bytes).toBe(5)
      const output = yield* readOutput(store, sessionID, row.id, 2, 16)
      expect(output.startOffset).toBe(4)
      expect(output.untrustedOutput).toBe("B")
      expect(output.eof).toBe(true)
      const small = yield* readOutput(store, sessionID, row.id, 1, 1)
      expect(small.startOffset).toBe(1)
      expect(small.nextOffset).toBe(4)
      expect(small.untrustedOutput).toBe("€")
    }),
  )

  it.live(
    "stops and flushes an owned process before returning",
    Effect.gen(function* () {
      const runtime = yield* SessionJobRuntime.Service
      const store = yield* SessionJobStore.Service
      const sessionID = yield* setup()
      const submitted = yield* runtime.submit({
        sessionID,
        assistantMessageID: "msg_assistant",
        toolCallID: "call-stop",
        command: "sleep 30",
        cwd: "/tmp",
        shell: "/bin/sh",
        timeout: 60_000,
        env: process.env,
      })
      yield* pollWithTimeout(
        store
          .get(sessionID, submitted.job.id)
          .pipe(Effect.map((value) => (value.status === "running" ? value : undefined))),
        "background job did not start",
      )
      const stopped = yield* runtime.stop(sessionID, submitted.job.id)
      expect(stopped.status).toBe("cancelled")
      expect(stopped.errorCode).toBe("explicit_stop")
    }),
  )

  it.live(
    "leaves background jobs running when the foreground runner is cancelled",
    Effect.gen(function* () {
      const runtime = yield* SessionJobRuntime.Service
      const store = yield* SessionJobStore.Service
      const sessionID = yield* setup()
      const submitted = yield* runtime.submit({
        sessionID,
        assistantMessageID: "msg_assistant",
        toolCallID: "call-foreground-cancel",
        command: "sleep 30",
        cwd: "/tmp",
        shell: "/bin/sh",
        timeout: 60_000,
        env: process.env,
      })
      yield* pollWithTimeout(
        store
          .get(sessionID, submitted.job.id)
          .pipe(Effect.map((value) => (value.status === "running" ? value : undefined))),
        "background job did not start",
      )

      const ready = yield* Latch.make()
      const foreground = Runner.make<void>(yield* Scope.Scope, {
        onIdle: Effect.void,
        onBusy: Effect.void,
        onInterrupt: Effect.void,
      })
      yield* foreground.ensureRunning(ready.open.pipe(Effect.andThen(Effect.never))).pipe(Effect.forkChild)
      yield* ready.await
      yield* foreground.cancel

      expect((yield* store.get(sessionID, submitted.job.id)).status).toBe("running")
      yield* runtime.stop(sessionID, submitted.job.id)
    }),
  )

  it.live(
    "launches an exact retry whose prior submission was abandoned at queued",
    Effect.gen(function* () {
      const runtime = yield* SessionJobRuntime.Service
      const store = yield* SessionJobStore.Service
      const sessionID = yield* setup()
      const input = {
        sessionID,
        assistantMessageID: "msg_assistant",
        toolCallID: "call-queued-retry",
        command: "printf recovered",
        cwd: "/tmp",
        shell: "/bin/sh",
        timeout: 10_000,
        env: process.env,
      }
      const inserted = yield* store.submit({ ...input, outputPath: `/tmp/${crypto.randomUUID()}.log` })
      expect(inserted.row.status).toBe("queued")

      const retried = yield* runtime.submit(input)
      expect(retried.created).toBe(false)
      const row = yield* pollWithTimeout(
        store
          .get(sessionID, retried.job.id)
          .pipe(Effect.map((value) => (value.time_completed === null ? undefined : value))),
        "exact retry did not recover the queued launch",
      )
      expect(row.status).toBe("completed")
      expect((yield* readOutput(store, sessionID, row.id, 0, 32)).untrustedOutput).toBe("recovered")
    }),
  )

  it.live(
    "keeps a job healthy and wakes it when started, progress, and completion listeners fail",
    Effect.gen(function* () {
      const runtime = yield* SessionJobRuntime.Service
      const store = yield* SessionJobStore.Service
      const events = yield* EventV2Bridge.Service
      const sessionID = yield* setup()
      const woken = yield* Latch.make()
      const seen = new Set<string>()
      yield* runtime.setWake((owner) => (owner === sessionID ? woken.open : Effect.void))
      const unsubscribe = yield* events.listen((event) => {
        if (!new Set(["session.job.started", "session.job.progress", "session.job.completed"]).has(event.type)) {
          return Effect.void
        }
        return Effect.sync(() => seen.add(event.type)).pipe(Effect.andThen(Effect.die("listener failed")))
      })
      yield* Effect.addFinalizer(() => unsubscribe)

      const submitted = yield* runtime.submit({
        sessionID,
        assistantMessageID: "msg_assistant",
        toolCallID: "call-listener-failure",
        command: "printf done",
        cwd: "/tmp",
        shell: "/bin/sh",
        timeout: 10_000,
        env: process.env,
      })
      yield* woken.await.pipe(Effect.timeout("2 seconds"))
      const row = yield* pollWithTimeout(
        store
          .get(sessionID, submitted.job.id)
          .pipe(Effect.map((value) => (value.time_completed === null ? undefined : value))),
        "job did not complete after an event listener failed",
      )
      expect(row.status).toBe("completed")
      expect(seen).toEqual(new Set(["session.job.started", "session.job.progress", "session.job.completed"]))
    }),
  )

  it.live(
    "returns the concurrent-job limit as a typed submission error",
    Effect.gen(function* () {
      const runtime = yield* SessionJobRuntime.Service
      const store = yield* SessionJobStore.Service
      const sessionID = yield* setup()
      yield* Effect.forEach(
        Array.from({ length: 4 }, (_, index) => index),
        (index) =>
          store.submit({
            sessionID,
            assistantMessageID: "msg_assistant",
            toolCallID: `call-active-${index}`,
            command: "sleep 30",
            cwd: "/tmp",
            shell: "/bin/sh",
            timeout: 60_000,
            outputPath: `/tmp/${crypto.randomUUID()}.log`,
          }),
        { discard: true },
      )
      const error = yield* runtime
        .submit({
          sessionID,
          assistantMessageID: "msg_assistant",
          toolCallID: "call-active-rejected",
          command: "sleep 30",
          cwd: "/tmp",
          shell: "/bin/sh",
          timeout: 60_000,
          env: process.env,
        })
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(SessionJobStore.ActiveLimitExceeded)
    }),
  )

  it.live(
    "returns a protected-output quota failure after eviction cannot free space",
    Effect.gen(function* () {
      const runtime = yield* SessionJobRuntime.Service
      const store = yield* SessionJobStore.Service
      const sessionID = yield* setup()
      yield* Effect.forEach(
        Array.from({ length: 5 }, (_, index) => index),
        Effect.fnUntraced(function* (index) {
          const submitted = yield* store.submit({
            sessionID,
            assistantMessageID: "msg_assistant",
            toolCallID: `call-protected-${index}`,
            command: "printf output",
            cwd: "/tmp",
            shell: "/bin/sh",
            timeout: 60_000,
            outputPath: `/tmp/${crypto.randomUUID()}.log`,
          })
          const claimed = yield* store.claimLaunch(sessionID, submitted.row.id, "quota-runtime")
          if (!claimed) return yield* Effect.die("quota test launch claim failed")
          yield* store.markRunning(sessionID, claimed.id, "quota-runtime", claimed.launch_fence)
          yield* store.finish({
            sessionID,
            jobID: claimed.id,
            runtimeID: "quota-runtime",
            fence: claimed.launch_fence,
            status: "completed",
            exitCode: 0,
            outputBytes: MAX_JOB_OUTPUT,
            outputTruncated: false,
            droppedBytes: 0,
          })
        }),
        { discard: true },
      )

      const error = yield* runtime
        .submit({
          sessionID,
          assistantMessageID: "msg_assistant",
          toolCallID: "call-protected-rejected",
          command: "printf rejected",
          cwd: "/tmp",
          shell: "/bin/sh",
          timeout: 60_000,
          env: process.env,
        })
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(SessionJobStore.OutputQuotaExceeded)
    }),
  )

  it.live(
    "enforces the mandatory runtime timeout",
    Effect.gen(function* () {
      const runtime = yield* SessionJobRuntime.Service
      const store = yield* SessionJobStore.Service
      const sessionID = yield* setup()
      const submitted = yield* runtime.submit({
        sessionID,
        assistantMessageID: "msg_assistant",
        toolCallID: "call-timeout",
        command: "sleep 30",
        cwd: "/tmp",
        shell: "/bin/sh",
        timeout: 100,
        env: process.env,
      })
      const row = yield* pollWithTimeout(
        store
          .get(sessionID, submitted.job.id)
          .pipe(Effect.map((value) => (value.time_completed === null ? undefined : value))),
        "background job did not time out",
      )
      expect(row.status).toBe("timed_out")
      expect(row.error_code).toBe("timed_out")
    }),
  )

  it.live(
    "captures combined output in one stream and truncates at the per-job quota",
    Effect.gen(function* () {
      const runtime = yield* SessionJobRuntime.Service
      const store = yield* SessionJobStore.Service
      const sessionID = yield* setup()
      const submitted = yield* runtime.submit({
        sessionID,
        assistantMessageID: "msg_assistant",
        toolCallID: "call-quota",
        command: `printf stdout; printf stderr >&2; head -c ${MAX_JOB_OUTPUT + 17} /dev/zero | tr '\\0' x`,
        cwd: "/tmp",
        shell: "/bin/sh",
        timeout: 20_000,
        env: process.env,
      })
      const row = yield* pollWithTimeout(
        store
          .get(sessionID, submitted.job.id)
          .pipe(Effect.map((value) => (value.time_completed === null ? undefined : value))),
        "large background job did not complete",
      )
      expect(row.status).toBe("completed")
      expect(row.output_bytes).toBe(MAX_JOB_OUTPUT)
      expect(row.output_truncated).toBe(true)
      expect(row.output_dropped_bytes).toBeGreaterThanOrEqual(17)
      const output = yield* readOutput(store, sessionID, row.id, 0, 32)
      expect(output.untrustedOutput).toContain("stdout")

      const streams = yield* runtime.submit({
        sessionID,
        assistantMessageID: "msg_assistant",
        toolCallID: "call-streams",
        command: "printf stdout; sleep 0.05; printf stderr >&2",
        cwd: "/tmp",
        shell: "/bin/sh",
        timeout: 10_000,
        env: process.env,
      })
      const streamRow = yield* pollWithTimeout(
        store
          .get(sessionID, streams.job.id)
          .pipe(Effect.map((value) => (value.time_completed === null ? undefined : value))),
        "combined-stream background job did not complete",
      )
      const combined = yield* readOutput(store, sessionID, streamRow.id, 0, 32)
      expect(combined.untrustedOutput).toBe("stdoutstderr")
    }),
  )

  it.live(
    "does not count output bytes whose underlying write failed",
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const runtime = yield* SessionJobRuntime.Service
      const store = yield* SessionJobStore.Service
      const sessionID = yield* setup()
      const input = {
        sessionID,
        assistantMessageID: "msg_assistant",
        toolCallID: "call-write-failure",
        command: "printf failed-write",
        cwd: "/tmp",
        shell: "/bin/sh",
        timeout: 10_000,
        env: process.env,
      }
      yield* store.submit({ ...input, outputPath: "/dev/full" })
      const submitted = yield* runtime.submit(input)
      const row = yield* pollWithTimeout(
        store
          .get(sessionID, submitted.job.id)
          .pipe(Effect.map((value) => (value.time_completed === null ? undefined : value))),
        "failed output write did not reach terminal state",
      )
      expect(row.status).toBe("failed")
      expect(row.error_code).toBe("output_capture_failed")
      expect(row.output_bytes).toBe(0)
    }),
  )

  it.live(
    "cancels all jobs owned by a session during graceful cleanup",
    Effect.gen(function* () {
      const runtime = yield* SessionJobRuntime.Service
      const store = yield* SessionJobStore.Service
      const sessionID = yield* setup()
      const submitted = yield* runtime.submit({
        sessionID,
        assistantMessageID: "msg_assistant",
        toolCallID: "call-session-cleanup",
        command: "sleep 30",
        cwd: "/tmp",
        shell: "/bin/sh",
        timeout: 60_000,
        env: process.env,
      })
      yield* pollWithTimeout(
        store
          .get(sessionID, submitted.job.id)
          .pipe(Effect.map((value) => (value.status === "running" ? value : undefined))),
        "background job did not start",
      )
      yield* runtime.cancelSession(sessionID)
      const row = yield* store.get(sessionID, submitted.job.id)
      expect(row.status).toBe("interrupted")
      expect(row.error_code).toBe("runtime_shutdown")
    }),
  )

  it.live(
    "terminates the owned process tree on explicit stop",
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const runtime = yield* SessionJobRuntime.Service
      const store = yield* SessionJobStore.Service
      const sessionID = yield* setup()
      const submitted = yield* runtime.submit({
        sessionID,
        assistantMessageID: "msg_assistant",
        toolCallID: "call-tree-stop",
        command: "sh -c 'sleep 30 & child=$!; printf \"$child\\n\"; wait'",
        cwd: "/tmp",
        shell: "/bin/sh",
        timeout: 60_000,
        env: process.env,
      })
      const childPID = yield* pollWithTimeout(
        readOutput(store, sessionID, submitted.job.id, 0, 64).pipe(
          Effect.map((output) => {
            const pid = Number.parseInt(output.untrustedOutput.trim(), 10)
            return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
          }),
        ),
        "background child PID was not captured",
      )
      yield* runtime.stop(sessionID, submitted.job.id)
      yield* pollWithTimeout(
        Effect.sync(() => {
          try {
            process.kill(childPID, 0)
            return undefined
          } catch {
            return true as const
          }
        }),
        "background child process survived explicit stop",
      )
    }),
  )
})
