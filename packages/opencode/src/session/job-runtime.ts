import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { SessionJob } from "@opencode-ai/schema/session-job"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { Clock, Context, Deferred, Duration, Effect, Fiber, Layer, Scope, Semaphore, Stream } from "effect"
import { mkdir, open, rm } from "node:fs/promises"
import path from "path"
import type { SessionID } from "./schema"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MAX_JOB_OUTPUT, RECOVERY_LEASE, SessionJobStore, info, type Row } from "./job-store"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"

type Handle = {
  readonly sessionID: SessionID
  readonly stop: Deferred.Deferred<"explicit_stop" | "runtime_shutdown">
  readonly fiber: Fiber.Fiber<void>
}

export interface Interface {
  readonly submit: (input: {
    sessionID: SessionID
    assistantMessageID: string
    toolCallID: string
    command: string
    cwd: string
    shell: string
    timeout: number
    env: NodeJS.ProcessEnv
  }) => Effect.Effect<
    { job: SessionJob.Info; created: boolean },
    SessionJobStore.SubmissionConflict | SessionJobStore.ActiveLimitExceeded | SessionJobStore.OutputQuotaExceeded
  >
  readonly stop: (sessionID: SessionID, jobID: string) => Effect.Effect<SessionJob.Info, SessionJobStore.NotFound>
  readonly cancelSession: (sessionID: SessionID) => Effect.Effect<void>
  readonly removeSessionOutput: (sessionID: SessionID) => Effect.Effect<void>
  readonly setWake: (callback: (sessionID: SessionID) => Effect.Effect<void>) => Effect.Effect<void>
  /**
   * Explicitly terminates every job this runtime instance owns and reconciles their
   * durable status. Called directly (not relied on as a Scope finalizer) from the CLI's
   * exit path, since this service is built through a shared, process-lifetime memoMap —
   * disposing any single ManagedRuntime built atop that memoMap does not reliably close
   * this service's own Layer.effect construction scope, so its `Effect.addFinalizer`
   * registration cannot be trusted to run on process exit. Idempotent: safe to call more
   * than once (e.g. once explicitly, and again if a Scope finalizer also happens to run).
   */
  readonly shutdown: () => Effect.Effect<void>
  readonly runtimeID: string
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionJobRuntime") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* SessionJobStore.Service
    const spawner = yield* ChildProcessSpawner
    const events = yield* EventV2Bridge.Service
    const { db } = yield* Database.Service
    const scope = yield* Scope.Scope
    const clock = yield* Clock.Clock
    const runtimeID = crypto.randomUUID()
    const handles = new Map<string, Handle>()
    let closing = false
    let wake = (_sessionID: SessionID): Effect.Effect<void> => Effect.void
    const reconcileStale = Effect.fn("SessionJobRuntime.reconcileStale")(function* () {
      const now = yield* clock.currentTimeMillis
      const sessions = yield* db.select({ id: SessionTable.id }).from(SessionTable).all().pipe(Effect.orDie)
      return yield* Effect.filter(sessions, (session) =>
        store.reconcileStale(session.id, now).pipe(Effect.map((rows) => rows.length > 0)),
      )
    })
    const startupPending = yield* reconcileStale()

    const deleteRetained = Effect.fn("SessionJobRuntime.deleteRetained")(function* (rows: Row[]) {
      yield* Effect.forEach(
        rows,
        (row) => {
          const token = row.output_delete_token
          if (!token) return Effect.die(`Missing output deletion token for job ${row.id}`)
          return Effect.promise(() => rm(row.output_path, { force: true })).pipe(
            Effect.matchCauseEffect({
              onFailure: (cause) =>
                store
                  .completeRetention(row.session_id, row.id, token, false)
                  .pipe(
                    Effect.andThen(
                      Effect.logError("background session job output deletion failed", { jobID: row.id, cause }),
                    ),
                  ),
              onSuccess: () => store.completeRetention(row.session_id, row.id, token, true),
            }),
          )
        },
        { concurrency: 8, discard: true },
      )
    })

    const cleanup = Effect.fn("SessionJobRuntime.cleanup")(function* (requiredBytes = 0) {
      const sessions = yield* db.select({ id: SessionTable.id }).from(SessionTable).all().pipe(Effect.orDie)
      const rows = yield* Effect.flatMap(
        Effect.forEach(sessions, (session) => store.retention(session.id, requiredBytes)),
        (items) => Effect.succeed(items.flat()),
      )
      yield* deleteRetained(rows)
    })
    yield* Effect.forever(Effect.sleep("1 hour").pipe(Effect.andThen(cleanup()))).pipe(Effect.forkIn(scope))

    const publishCompleted = Effect.fn("SessionJobRuntime.publishCompleted")(function* (row: Row) {
      if (!closing) yield* wake(row.session_id)
      yield* events
        .publish(SessionJob.Events.Completed, {
          sessionID: row.session_id,
          jobID: row.id,
          status: row.status,
          outputBytes: row.output_bytes,
          outputTruncated: row.output_truncated,
          ...(row.exit_code === null ? {} : { exitCode: row.exit_code }),
          ...(row.error_code === null ? {} : { errorCode: row.error_code }),
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logError("background session job completion event failed", { jobID: row.id, cause }),
          ),
        )
    })

    const launch = Effect.fn("SessionJobRuntime.launch")(function* (row: Row, env: NodeJS.ProcessEnv) {
      const claimed = yield* store.claimLaunch(row.session_id, row.id, runtimeID, process.pid)
      if (!claimed) return
      const stop = yield* Deferred.make<"explicit_stop" | "runtime_shutdown">()
      const actor = Effect.scoped(
        Effect.gen(function* () {
          const output = yield* Effect.promise(async () => {
            await mkdir(path.dirname(claimed.output_path), { recursive: true })
            return open(claimed.output_path, "a")
          })
          let bytes: number = 0
          let dropped: number = 0
          let truncated: boolean = false
          let outputFailed: boolean = false
          let lastProgress = 0
          const decoder = new TextDecoder("utf-8", { fatal: false })

          const flushText = Effect.fnUntraced(function* (text: string) {
            if (!text) return
            const encoded = new TextEncoder().encode(text)
            const room = MAX_JOB_OUTPUT - bytes
            const chunk = room >= encoded.byteLength ? encoded : codePointPrefix(encoded, Math.max(0, room))
            const written =
              chunk.byteLength === 0
                ? false
                : yield* Effect.promise(() => output.writeFile(chunk)).pipe(
                    Effect.as(true),
                    Effect.catch(() =>
                      Effect.sync(() => {
                        outputFailed = true
                        return false
                      }),
                    ),
                  )
            if (written) bytes += chunk.byteLength
            dropped += encoded.byteLength - (written ? chunk.byteLength : 0)
            truncated ||= !written || chunk.byteLength !== encoded.byteLength
            const now = Date.now()
            if (now - lastProgress < 250) return
            lastProgress = now
            if (
              yield* store.progress({
                sessionID: claimed.session_id,
                jobID: claimed.id,
                runtimeID,
                fence: claimed.launch_fence,
                outputBytes: bytes,
                outputTruncated: truncated,
                droppedBytes: dropped,
              })
            ) {
              yield* events
                .publish(SessionJob.Events.Progress, {
                  sessionID: claimed.session_id,
                  jobID: claimed.id,
                  outputBytes: bytes,
                  outputTruncated: truncated,
                })
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logError("background session job progress event failed", { jobID: claimed.id, cause }),
                  ),
                )
            }
          })

          const command =
            process.platform === "win32" && /(?:^|[\\/])(powershell|pwsh)(?:\.exe)?$/i.test(claimed.shell)
              ? ChildProcess.make(
                  claimed.shell,
                  ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", claimed.command],
                  {
                    cwd: claimed.cwd,
                    env,
                    stdin: "ignore",
                  },
                )
              : ChildProcess.make(claimed.command, [], {
                  shell: claimed.shell,
                  cwd: claimed.cwd,
                  env,
                  stdin: "ignore",
                  detached: process.platform !== "win32",
                })

          const spawned = yield* spawner.spawn(command).pipe(Effect.exit)
          if (spawned._tag === "Failure") {
            yield* Effect.promise(() => output.sync()).pipe(Effect.catch(() => Effect.void))
            yield* Effect.promise(() => output.close()).pipe(Effect.catch(() => Effect.void))
            const changed = yield* store.finish({
              sessionID: claimed.session_id,
              jobID: claimed.id,
              runtimeID,
              fence: claimed.launch_fence,
              status: "failed",
              errorCode: "spawn_failed",
              diagnosticError: String(spawned.cause),
              outputBytes: bytes,
              outputTruncated: truncated,
              droppedBytes: dropped,
            })
            if (changed) yield* publishCompleted(yield* store.get(claimed.session_id, claimed.id).pipe(Effect.orDie))
            return
          }
          const handle = spawned.value
          yield* Effect.addFinalizer(() =>
            handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.catch(() => Effect.void)),
          )
          const running = yield* store.markRunning(
            claimed.session_id,
            claimed.id,
            runtimeID,
            claimed.launch_fence,
            "pid" in handle && typeof handle.pid === "number" ? handle.pid : undefined,
          )
          if (!running) {
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.catch(() => Effect.void))
            yield* Effect.promise(() => output.close()).pipe(Effect.catch(() => Effect.void))
            return
          }
          yield* events
            .publish(SessionJob.Events.Started, { sessionID: claimed.session_id, jobID: claimed.id })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logError("background session job started event failed", { jobID: claimed.id, cause }),
              ),
            )

          const outputFiber = yield* Stream.runForEach(handle.all, (chunk) =>
            flushText(decoder.decode(chunk, { stream: true })),
          ).pipe(Effect.ensuring(flushText(decoder.decode())), Effect.forkScoped)
          const result = yield* Effect.raceAll([
            handle.exitCode.pipe(Effect.map((exitCode) => ({ type: "exit" as const, exitCode }))),
            Deferred.await(stop).pipe(Effect.map((reason) => ({ type: "stop" as const, reason }))),
            Effect.sleep(`${Math.max(0, (claimed.deadline_at ?? Date.now()) - Date.now())} millis`).pipe(
              Effect.as({ type: "timeout" as const }),
            ),
          ])
          if (result.type !== "exit") {
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.catch(() => Effect.void))
            yield* handle.exitCode.pipe(Effect.catch(() => Effect.succeed(null)))
          }
          yield* Fiber.join(outputFiber).pipe(Effect.catch(() => Effect.sync(() => (outputFailed = true))))
          yield* Effect.promise(() => output.sync()).pipe(Effect.catch(() => Effect.sync(() => (outputFailed = true))))
          yield* Effect.promise(() => output.close()).pipe(Effect.catch(() => Effect.sync(() => (outputFailed = true))))

          const terminal = outputFailed
            ? { status: "failed" as const, errorCode: "output_capture_failed" as const }
            : result.type === "timeout"
              ? { status: "timed_out" as const, errorCode: "timed_out" as const }
              : result.type === "stop"
                ? {
                    status: result.reason === "explicit_stop" ? ("cancelled" as const) : ("interrupted" as const),
                    errorCode: result.reason,
                  }
                : result.exitCode === 0
                  ? { status: "completed" as const, exitCode: result.exitCode }
                  : { status: "failed" as const, exitCode: result.exitCode, errorCode: "nonzero_exit" as const }
          const changed = yield* store.finish({
            sessionID: claimed.session_id,
            jobID: claimed.id,
            runtimeID,
            fence: claimed.launch_fence,
            ...terminal,
            outputBytes: bytes,
            outputTruncated: truncated,
            droppedBytes: dropped,
          })
          if (changed) yield* publishCompleted(yield* store.get(claimed.session_id, claimed.id).pipe(Effect.orDie))
        }),
      ).pipe(
        Effect.ensuring(Effect.sync(() => handles.delete(row.id))),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const current = yield* store.get(row.session_id, row.id).pipe(Effect.orDie)
            const changed = yield* store.finish({
              sessionID: row.session_id,
              jobID: row.id,
              runtimeID,
              fence: current.launch_fence,
              status: "failed",
              errorCode: "output_capture_failed",
              diagnosticError: String(cause),
              outputBytes: current.output_bytes,
              outputTruncated: current.output_truncated,
              droppedBytes: current.output_dropped_bytes,
            })
            if (changed) yield* publishCompleted(yield* store.get(row.session_id, row.id).pipe(Effect.orDie))
            yield* Effect.logError("background session job actor failed", { jobID: row.id, cause })
          }),
        ),
      )
      const fiber = yield* actor.pipe(Effect.forkIn(scope))
      handles.set(row.id, { sessionID: row.session_id, stop, fiber })
      if (fiber.pollUnsafe()) handles.delete(row.id)
    })

    const abandon = Effect.fn("SessionJobRuntime.abandon")(function* (sessionID: SessionID, jobID: string) {
      if (!(yield* store.abandon(sessionID, jobID))) return
      yield* publishCompleted(yield* store.get(sessionID, jobID).pipe(Effect.orDie))
    })

    const submit: Interface["submit"] = Effect.fn("SessionJobRuntime.submit")((input) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const outputPath = path.join(Global.Path.data, "session-job", input.sessionID, `${jobName(input)}.log`)
          const insert = store.submit({ ...input, outputPath })
          const submitted = yield* insert.pipe(
            Effect.catchTag("SessionJobOutputQuotaExceeded", () =>
              Effect.gen(function* () {
                yield* deleteRetained(yield* store.retention(input.sessionID, MAX_JOB_OUTPUT))
                return yield* insert
              }),
            ),
          )
          if (submitted.row.status === "queued") {
            yield* launch(submitted.row, input.env).pipe(Effect.ensuring(abandon(input.sessionID, submitted.row.id)))
          }
          return {
            job: info(yield* store.get(input.sessionID, submitted.row.id).pipe(Effect.orDie)),
            created: submitted.created,
          }
        }),
      ),
    )

    const stop: Interface["stop"] = Effect.fn("SessionJobRuntime.stop")(function* (sessionID, jobID) {
      yield* store.get(sessionID, jobID)
      const handle = handles.get(jobID)
      if (handle) {
        yield* Deferred.succeed(handle.stop, "explicit_stop").pipe(Effect.asVoid)
        yield* Fiber.await(handle.fiber)
      }
      return info(yield* store.get(sessionID, jobID))
    })

    const cancelSession: Interface["cancelSession"] = Effect.fn("SessionJobRuntime.cancelSession")(
      function* (sessionID) {
        const active = (yield* store.list(sessionID)).filter(
          (row) => row.status === "starting" || row.status === "running",
        )
        yield* Effect.forEach(
          active,
          (row) => {
            const handle = handles.get(row.id)
            return handle ? Deferred.succeed(handle.stop, "runtime_shutdown").pipe(Effect.asVoid) : Effect.void
          },
          { discard: true },
        )
        yield* Effect.forEach(
          active,
          (row) => {
            const handle = handles.get(row.id)
            return handle ? Fiber.await(handle.fiber).pipe(Effect.asVoid) : Effect.void
          },
          { concurrency: "unbounded", discard: true },
        )
        // Explicit session deletion invalidates every durable job in that session. This is
        // intentionally session-wide, unlike startup recovery, which must preserve live
        // jobs owned by other runtimes.
        yield* store.interruptSession(sessionID)
      },
    )

    const removeSessionOutput: Interface["removeSessionOutput"] = Effect.fn("SessionJobRuntime.removeSessionOutput")(
      function* (sessionID) {
        yield* cancelSession(sessionID)
        yield* Effect.promise(() =>
          rm(path.join(Global.Path.data, "session-job", sessionID), { recursive: true, force: true }),
        ).pipe(Effect.catch(() => Effect.void))
      },
    )

    const shutdownLock = Semaphore.makeUnsafe(1)
    let shutdownComplete = false
    let shutdownTargets: { sessionID: SessionID; jobID: string }[] | undefined
    const shutdown: Interface["shutdown"] = Effect.fnUntraced(function* () {
      yield* shutdownLock.withPermit(
        Effect.gen(function* () {
          if (shutdownComplete) return
          closing = true
          shutdownTargets ??= [...handles].map(([jobID, handle]) => ({ sessionID: handle.sessionID, jobID }))
          yield* Effect.forEach(
            shutdownTargets,
            (target) => {
              const handle = handles.get(target.jobID)
              return handle ? Deferred.succeed(handle.stop, "runtime_shutdown") : Effect.void
            },
            { discard: true },
          )
          yield* Effect.forEach(
            shutdownTargets,
            (target) => {
              const handle = handles.get(target.jobID)
              return handle ? Fiber.await(handle.fiber).pipe(Effect.asVoid) : Effect.void
            },
            { concurrency: "unbounded", discard: true },
          )
          const sessions = shutdownTargets.reduce((result, target) => {
            result.set(target.sessionID, [...(result.get(target.sessionID) ?? []), target.jobID])
            return result
          }, new Map<SessionID, string[]>())
          yield* Effect.forEach(
            sessions,
            ([sessionID, jobIDs]) => store.reconcileOwned(sessionID, runtimeID, jobIDs).pipe(Effect.asVoid),
            { discard: true },
          )
          shutdownComplete = true
        }),
      )
    })

    yield* Effect.addFinalizer(() => shutdown())

    let recoveryScheduled = false
    const notify = (sessions: { id: SessionID }[]) =>
      Effect.forEach(sessions, (session) => wake(session.id), { concurrency: 8, discard: true })
    const recoverAfterLease = (attempt: number): Effect.Effect<void> =>
      reconcileStale().pipe(
        Effect.flatMap(notify),
        Effect.catchCause((cause) =>
          Effect.logError("background session job delayed recovery failed", { attempt, cause }).pipe(
            Effect.andThen(
              attempt < 3
                ? clock
                    .sleep(Duration.seconds(1))
                    .pipe(Effect.andThen(Effect.suspend(() => recoverAfterLease(attempt + 1))))
                : Effect.void,
            ),
          ),
        ),
      )
    const setWake: Interface["setWake"] = (callback) =>
      Effect.gen(function* () {
        wake = callback
        yield* notify(startupPending).pipe(Effect.forkIn(scope))
        if (recoveryScheduled) return
        recoveryScheduled = true
        yield* clock
          .sleep(Duration.millis(RECOVERY_LEASE + 100))
          .pipe(Effect.andThen(recoverAfterLease(1)), Effect.forkIn(scope))
      })

    return Service.of({ submit, stop, cancelSession, removeSessionOutput, setWake, shutdown, runtimeID })
  }),
)

function jobName(input: { sessionID: SessionID; assistantMessageID: string; toolCallID: string }) {
  return new Bun.CryptoHasher("sha256")
    .update(["opencode-session-shell-job-v1", input.sessionID, input.assistantMessageID, input.toolCallID].join("\0"))
    .digest("hex")
}

function codePointPrefix(bytes: Uint8Array, limit: number) {
  if (bytes.byteLength <= limit) return bytes
  let end = limit
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  return bytes.subarray(0, end)
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [SessionJobStore.node, CrossSpawnSpawner.node, EventV2Bridge.node, Database.node],
})

export * as SessionJobRuntime from "./job-runtime"
