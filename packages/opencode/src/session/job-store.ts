import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionJobOutputReadTable, SessionJobTable } from "@opencode-ai/core/session/sql"
import { SessionJob } from "@opencode-ai/schema/session-job"
import { and, asc, count, eq, gt, inArray, isNull, lt, ne, or, sql, sum } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import type { SessionID } from "./schema"

const ACTIVE = ["queued", "starting", "running"] as const
const TERMINAL = ["completed", "failed", "timed_out", "cancelled", "interrupted"] as const
export const MAX_ACTIVE = 4
export const MAX_JOB_OUTPUT = 10 * 1024 * 1024
export const MAX_SESSION_OUTPUT = 50 * 1024 * 1024

export type Row = typeof SessionJobTable.$inferSelect

export class SubmissionConflict extends Schema.TaggedErrorClass<SubmissionConflict>()("SessionJobSubmissionConflict", {
  jobID: Schema.String,
}) {}

export class ActiveLimitExceeded extends Schema.TaggedErrorClass<ActiveLimitExceeded>()(
  "SessionJobActiveLimitExceeded",
  {
    limit: Schema.Number,
  },
) {}

export class OutputQuotaExceeded extends Schema.TaggedErrorClass<OutputQuotaExceeded>()(
  "SessionJobOutputQuotaExceeded",
  {
    limit: Schema.Number,
  },
) {}

export class NotFound extends Schema.TaggedErrorClass<NotFound>()("SessionJobNotFound", {
  jobID: Schema.String,
}) {}

export interface Interface {
  readonly submit: (input: {
    sessionID: SessionID
    assistantMessageID: string
    toolCallID: string
    command: string
    cwd: string
    shell: string
    timeout: number
    outputPath: string
  }) => Effect.Effect<{ row: Row; created: boolean }, SubmissionConflict | ActiveLimitExceeded | OutputQuotaExceeded>
  readonly list: (sessionID: SessionID) => Effect.Effect<Row[]>
  readonly get: (sessionID: SessionID, jobID: string) => Effect.Effect<Row, NotFound>
  readonly claimLaunch: (sessionID: SessionID, jobID: string, runtimeID: string) => Effect.Effect<Row | undefined>
  readonly markRunning: (
    sessionID: SessionID,
    jobID: string,
    runtimeID: string,
    fence: number,
    pid?: number,
  ) => Effect.Effect<boolean>
  readonly progress: (input: {
    sessionID: SessionID
    jobID: string
    runtimeID: string
    fence: number
    outputBytes: number
    outputTruncated: boolean
    droppedBytes: number
  }) => Effect.Effect<boolean>
  readonly finish: (input: {
    sessionID: SessionID
    jobID: string
    runtimeID: string
    fence: number
    status: SessionJob.Status
    exitCode?: number
    signal?: string
    errorCode?: SessionJob.ErrorCode
    diagnosticError?: string
    outputBytes: number
    outputTruncated: boolean
    droppedBytes: number
  }) => Effect.Effect<boolean>
  readonly abandon: (sessionID: SessionID, jobID: string) => Effect.Effect<boolean>
  readonly reconcile: (sessionID: SessionID, runtimeID: string) => Effect.Effect<Row[]>
  readonly reconcileOwned: (sessionID: SessionID, runtimeID: string, jobIDs: string[]) => Effect.Effect<Row[]>
  readonly claimNotifications: (sessionID: SessionID, token: string, now: number) => Effect.Effect<Row[]>
  readonly releaseClaim: (sessionID: SessionID, token: string) => Effect.Effect<void>
  readonly reserveAdmission: (
    sessionID: SessionID,
    token: string,
    batchID: string,
    messageID: string,
  ) => Effect.Effect<Row[]>
  readonly markAdmitted: (
    sessionID: SessionID,
    token: string,
    batchID: string,
    messageID: string,
  ) => Effect.Effect<Row[]>
  readonly markObserved: (
    sessionID: SessionID,
    notificationMessageIDs: string[],
    assistantMessageID: string,
  ) => Effect.Effect<Row[]>
  readonly markDelivered: (sessionID: SessionID, batchID: string) => Effect.Effect<void>
  readonly acquireOutputRead: (
    sessionID: SessionID,
    jobID: string,
    token: string,
    until: number,
  ) => Effect.Effect<boolean>
  readonly releaseOutputRead: (sessionID: SessionID, jobID: string, token: string) => Effect.Effect<void>
  readonly retention: (sessionID: SessionID, requiredBytes?: number) => Effect.Effect<Row[]>
  readonly completeRetention: (sessionID: SessionID, jobID: string, deleted: boolean) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionJobStore") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const get = Effect.fn("SessionJobStore.get")(function* (sessionID: SessionID, jobID: string) {
      const row = yield* db
        .select()
        .from(SessionJobTable)
        .where(and(eq(SessionJobTable.session_id, sessionID), eq(SessionJobTable.id, jobID)))
        .get()
        .pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die))
      if (!row) return yield* Effect.fail(new NotFound({ jobID }))
      return row
    })

    const list = Effect.fn("SessionJobStore.list")(function* (sessionID: SessionID) {
      return yield* db
        .select()
        .from(SessionJobTable)
        .where(eq(SessionJobTable.session_id, sessionID))
        .orderBy(asc(SessionJobTable.time_created), asc(SessionJobTable.id))
        .all()
        .pipe(Effect.orDie)
    })

    const submit: Interface["submit"] = Effect.fn("SessionJobStore.submit")(function* (input) {
      const identity = [
        "opencode-session-shell-job-v1",
        input.sessionID,
        input.assistantMessageID,
        input.toolCallID,
      ].join("\0")
      const id = `job_${new Bun.CryptoHasher("sha256").update(identity).digest("hex")}`
      const submission = JSON.stringify({
        background: true,
        command: input.command,
        cwd: input.cwd,
        shell: input.shell,
        timeout: input.timeout,
      })
      const submissionHash = new Bun.CryptoHasher("sha256").update(submission).digest("hex")
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const existing = yield* tx
                .select()
                .from(SessionJobTable)
                .where(and(eq(SessionJobTable.session_id, input.sessionID), eq(SessionJobTable.id, id)))
                .get()
              if (existing) {
                if (existing.submission_hash !== submissionHash) {
                  return yield* Effect.fail(new SubmissionConflict({ jobID: id }))
                }
                return { row: existing, created: false }
              }
              const active = yield* tx
                .select({ value: count() })
                .from(SessionJobTable)
                .where(and(eq(SessionJobTable.session_id, input.sessionID), inArray(SessionJobTable.status, ACTIVE)))
                .get()
              if ((active?.value ?? 0) >= MAX_ACTIVE) {
                return yield* Effect.fail(new ActiveLimitExceeded({ limit: MAX_ACTIVE }))
              }
              const retained = yield* tx
                .select({ value: sum(SessionJobTable.output_bytes) })
                .from(SessionJobTable)
                .where(
                  and(
                    eq(SessionJobTable.session_id, input.sessionID),
                    eq(SessionJobTable.output_expired, false),
                    inArray(SessionJobTable.status, TERMINAL),
                  ),
                )
                .get()
              if (Number(retained?.value ?? 0) + ((active?.value ?? 0) + 1) * MAX_JOB_OUTPUT > MAX_SESSION_OUTPUT) {
                return yield* Effect.fail(new OutputQuotaExceeded({ limit: MAX_SESSION_OUTPUT }))
              }
              const now = Date.now()
              const row = {
                id,
                session_id: input.sessionID,
                assistant_message_id: input.assistantMessageID,
                tool_call_id: input.toolCallID,
                submission_hash: submissionHash,
                command: input.command,
                cwd: input.cwd,
                shell: input.shell,
                timeout_ms: input.timeout,
                status: "queued" as const,
                output_path: input.outputPath,
                time_created: now,
                time_updated: now,
              }
              yield* tx.insert(SessionJobTable).values(row).run()
              const inserted = yield* tx.select().from(SessionJobTable).where(eq(SessionJobTable.id, id)).get()
              if (!inserted) return yield* Effect.die("session job insert did not return its row")
              return { row: inserted, created: true }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
        .pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die))
    })

    const claimLaunch: Interface["claimLaunch"] = Effect.fn("SessionJobStore.claimLaunch")(
      function* (sessionID, jobID, runtimeID) {
        const now = Date.now()
        const rows = yield* db
          .update(SessionJobTable)
          .set({
            status: "starting",
            runtime_id: runtimeID,
            launch_fence: sql`${SessionJobTable.launch_fence} + 1`,
            deadline_at: sql`${now} + ${SessionJobTable.timeout_ms}`,
            time_updated: now,
          })
          .where(
            and(
              eq(SessionJobTable.session_id, sessionID),
              eq(SessionJobTable.id, jobID),
              eq(SessionJobTable.status, "queued"),
            ),
          )
          .returning()
          .all()
          .pipe(Effect.orDie)
        return rows[0]
      },
    )

    const markRunning: Interface["markRunning"] = Effect.fn("SessionJobStore.markRunning")(
      function* (sessionID, jobID, runtimeID, fence, pid) {
        const changed = yield* db
          .update(SessionJobTable)
          .set({ status: "running", pid, time_started: Date.now(), time_updated: Date.now() })
          .where(fenced(sessionID, jobID, runtimeID, fence, ["starting"]))
          .returning({ id: SessionJobTable.id })
          .all()
          .pipe(Effect.orDie)
        return changed.length > 0
      },
    )

    const progress: Interface["progress"] = Effect.fn("SessionJobStore.progress")(function* (input) {
      const changed = yield* db
        .update(SessionJobTable)
        .set({
          output_bytes: input.outputBytes,
          output_truncated: input.outputTruncated,
          output_dropped_bytes: input.droppedBytes,
          time_updated: Date.now(),
        })
        .where(fenced(input.sessionID, input.jobID, input.runtimeID, input.fence, ["starting", "running"]))
        .returning({ id: SessionJobTable.id })
        .all()
        .pipe(Effect.orDie)
      return changed.length > 0
    })

    const finish: Interface["finish"] = Effect.fn("SessionJobStore.finish")(function* (input) {
      const changed = yield* db
        .update(SessionJobTable)
        .set({
          status: input.status,
          exit_code: input.exitCode,
          signal: input.signal,
          error_code: input.errorCode,
          diagnostic_error: input.diagnosticError?.slice(0, 1000),
          output_bytes: input.outputBytes,
          output_truncated: input.outputTruncated,
          output_dropped_bytes: input.droppedBytes,
          notification_state: "pending",
          notification_claim_token: null,
          notification_claim_until: null,
          time_completed: Date.now(),
          time_updated: Date.now(),
        })
        .where(fenced(input.sessionID, input.jobID, input.runtimeID, input.fence, ["starting", "running"]))
        .returning({ id: SessionJobTable.id })
        .all()
        .pipe(Effect.orDie)
      return changed.length > 0
    })

    const abandon: Interface["abandon"] = Effect.fn("SessionJobStore.abandon")(function* (sessionID, jobID) {
      const now = Date.now()
      const changed = yield* db
        .update(SessionJobTable)
        .set({
          status: "interrupted",
          error_code: "launch_abandoned",
          notification_state: "pending",
          time_completed: now,
          time_updated: now,
        })
        .where(
          and(
            eq(SessionJobTable.session_id, sessionID),
            eq(SessionJobTable.id, jobID),
            eq(SessionJobTable.status, "queued"),
          ),
        )
        .returning({ id: SessionJobTable.id })
        .all()
        .pipe(Effect.orDie)
      return changed.length > 0
    })

    const reconcile: Interface["reconcile"] = Effect.fn("SessionJobStore.reconcile")(function* (sessionID, runtimeID) {
      const now = Date.now()
      yield* db
        .update(SessionJobTable)
        .set({
          status: "interrupted",
          error_code: "runtime_shutdown",
          notification_state: "pending",
          time_completed: now,
          time_updated: now,
        })
        .where(
          and(
            eq(SessionJobTable.session_id, sessionID),
            inArray(SessionJobTable.status, ACTIVE),
            or(isNull(SessionJobTable.runtime_id), ne(SessionJobTable.runtime_id, runtimeID)),
          ),
        )
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(SessionJobTable)
        .set({ notification_state: "pending", notification_claim_token: null, notification_claim_until: null })
        .where(and(eq(SessionJobTable.session_id, sessionID), eq(SessionJobTable.notification_state, "claimed")))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(SessionJobTable)
        .set({ output_deleting: false, time_updated: now })
        .where(and(eq(SessionJobTable.session_id, sessionID), eq(SessionJobTable.output_deleting, true)))
        .run()
        .pipe(Effect.orDie)
      return (yield* list(sessionID)).filter(
        (row) => row.notification_state === "pending" || row.notification_state === "admitted",
      )
    })

    const reconcileOwned: Interface["reconcileOwned"] = Effect.fn("SessionJobStore.reconcileOwned")(
      function* (sessionID, runtimeID, jobIDs) {
        if (jobIDs.length === 0) return []
        const now = Date.now()
        return yield* db
          .update(SessionJobTable)
          .set({
            status: "interrupted",
            error_code: "runtime_shutdown",
            notification_state: "pending",
            time_completed: now,
            time_updated: now,
          })
          .where(
            and(
              eq(SessionJobTable.session_id, sessionID),
              inArray(SessionJobTable.id, jobIDs),
              eq(SessionJobTable.runtime_id, runtimeID),
              inArray(SessionJobTable.status, ACTIVE),
            ),
          )
          .returning()
          .all()
          .pipe(Effect.orDie)
      },
    )

    const claimNotifications: Interface["claimNotifications"] = Effect.fn("SessionJobStore.claimNotifications")(
      function* (sessionID, token, now) {
        return yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                yield* tx
                  .update(SessionJobTable)
                  .set({
                    notification_state: "pending",
                    notification_claim_token: null,
                    notification_claim_until: null,
                  })
                  .where(
                    and(
                      eq(SessionJobTable.session_id, sessionID),
                      eq(SessionJobTable.notification_state, "claimed"),
                      lt(SessionJobTable.notification_claim_until, now),
                    ),
                  )
                  .run()
                const rows = yield* tx
                  .select()
                  .from(SessionJobTable)
                  .where(
                    and(eq(SessionJobTable.session_id, sessionID), eq(SessionJobTable.notification_state, "pending")),
                  )
                  .orderBy(asc(SessionJobTable.time_completed), asc(SessionJobTable.id))
                  .limit(32)
                  .all()
                if (rows.length === 0) return []
                yield* tx
                  .update(SessionJobTable)
                  .set({
                    notification_state: "claimed",
                    notification_claim_token: token,
                    notification_claim_until: now + 30_000,
                  })
                  .where(
                    and(
                      eq(SessionJobTable.session_id, sessionID),
                      inArray(
                        SessionJobTable.id,
                        rows.map((row) => row.id),
                      ),
                      eq(SessionJobTable.notification_state, "pending"),
                    ),
                  )
                  .run()
                return rows.map((row) => ({
                  ...row,
                  notification_state: "claimed" as const,
                  notification_claim_token: token,
                  notification_claim_until: now + 30_000,
                }))
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      },
    )

    const releaseClaim: Interface["releaseClaim"] = Effect.fn("SessionJobStore.releaseClaim")(
      function* (sessionID, token) {
        yield* db
          .update(SessionJobTable)
          .set({ notification_state: "pending", notification_claim_token: null, notification_claim_until: null })
          .where(
            and(
              eq(SessionJobTable.session_id, sessionID),
              eq(SessionJobTable.notification_state, "claimed"),
              eq(SessionJobTable.notification_claim_token, token),
            ),
          )
          .run()
          .pipe(Effect.orDie)
      },
    )

    const reserveAdmission: Interface["reserveAdmission"] = Effect.fn("SessionJobStore.reserveAdmission")(
      function* (sessionID, token, batchID, messageID) {
        const rows = yield* db
          .update(SessionJobTable)
          .set({ notification_batch_id: batchID, notification_message_id: messageID })
          .where(
            and(
              eq(SessionJobTable.session_id, sessionID),
              eq(SessionJobTable.notification_state, "claimed"),
              eq(SessionJobTable.notification_claim_token, token),
            ),
          )
          .returning()
          .all()
          .pipe(Effect.orDie)
        if (rows.length === 0) return yield* Effect.die("Session job notification claim was lost before reservation")
        return rows
      },
    )

    // This operation is invoked from the durable PartUpdated event's commit hook. The
    // event projector inserts the typed notification part and this update runs in that
    // same immediate database transaction.
    const markAdmitted: Interface["markAdmitted"] = Effect.fn("SessionJobStore.markAdmitted")(
      function* (sessionID, token, batchID, messageID) {
        const rows = yield* db
          .update(SessionJobTable)
          .set({
            notification_state: "admitted",
            notification_batch_id: batchID,
            notification_message_id: messageID,
            notification_claim_token: null,
            notification_claim_until: null,
          })
          .where(
            and(
              eq(SessionJobTable.session_id, sessionID),
              eq(SessionJobTable.notification_state, "claimed"),
              eq(SessionJobTable.notification_claim_token, token),
            ),
          )
          .returning()
          .all()
          .pipe(Effect.orDie)
        if (rows.length === 0) return yield* Effect.die("Session job notification claim was lost before admission")
        return rows
      },
    )

    const markDelivered: Interface["markDelivered"] = Effect.fn("SessionJobStore.markDelivered")(
      function* (sessionID, batchID) {
        yield* db
          .update(SessionJobTable)
          .set({ notification_state: "delivered", notification_delivered_at: Date.now() })
          .where(
            and(
              eq(SessionJobTable.session_id, sessionID),
              eq(SessionJobTable.notification_state, "admitted"),
              eq(SessionJobTable.notification_batch_id, batchID),
            ),
          )
          .run()
          .pipe(Effect.orDie)
      },
    )

    const markObserved: Interface["markObserved"] = Effect.fn("SessionJobStore.markObserved")(
      function* (sessionID, notificationMessageIDs, assistantMessageID) {
        if (notificationMessageIDs.length === 0) return []
        return yield* db
          .update(SessionJobTable)
          .set({ notification_observed_message_id: assistantMessageID })
          .where(
            and(
              eq(SessionJobTable.session_id, sessionID),
              eq(SessionJobTable.notification_state, "admitted"),
              inArray(SessionJobTable.notification_message_id, notificationMessageIDs),
            ),
          )
          .returning()
          .all()
          .pipe(Effect.orDie)
      },
    )

    const acquireOutputRead: Interface["acquireOutputRead"] = Effect.fn("SessionJobStore.acquireOutputRead")(
      function* (sessionID, jobID, token, until) {
        return yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const row = yield* tx
                  .select({ expired: SessionJobTable.output_expired, deleting: SessionJobTable.output_deleting })
                  .from(SessionJobTable)
                  .where(and(eq(SessionJobTable.session_id, sessionID), eq(SessionJobTable.id, jobID)))
                  .get()
                if (!row || row.expired || row.deleting) return false
                yield* tx
                  .insert(SessionJobOutputReadTable)
                  .values({ token, session_id: sessionID, job_id: jobID, expires_at: until })
                  .run()
                return true
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      },
    )

    const releaseOutputRead: Interface["releaseOutputRead"] = Effect.fn("SessionJobStore.releaseOutputRead")(
      function* (sessionID, jobID, token) {
        yield* db
          .delete(SessionJobOutputReadTable)
          .where(
            and(
              eq(SessionJobOutputReadTable.session_id, sessionID),
              eq(SessionJobOutputReadTable.job_id, jobID),
              eq(SessionJobOutputReadTable.token, token),
            ),
          )
          .run()
          .pipe(Effect.orDie)
      },
    )

    const retention: Interface["retention"] = Effect.fn("SessionJobStore.retention")(function* (
      sessionID,
      requiredBytes = 0,
    ) {
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const now = Date.now()
              yield* tx.delete(SessionJobOutputReadTable).where(lt(SessionJobOutputReadTable.expires_at, now)).run()
              const active = yield* tx
                .select({ value: count() })
                .from(SessionJobTable)
                .where(and(eq(SessionJobTable.session_id, sessionID), inArray(SessionJobTable.status, ACTIVE)))
                .get()
              const rows = yield* tx
                .select()
                .from(SessionJobTable)
                .where(
                  and(
                    eq(SessionJobTable.session_id, sessionID),
                    inArray(SessionJobTable.status, TERMINAL),
                    eq(SessionJobTable.output_expired, false),
                    eq(SessionJobTable.output_deleting, false),
                  ),
                )
                .orderBy(asc(SessionJobTable.time_completed), asc(SessionJobTable.id))
                .all()
              const needed = Math.max(
                0,
                (active?.value ?? 0) * MAX_JOB_OUTPUT +
                  rows.reduce((total, row) => total + row.output_bytes, 0) +
                  requiredBytes -
                  MAX_SESSION_OUTPUT,
              )
              const leases = new Set(
                (yield* tx
                  .select({ jobID: SessionJobOutputReadTable.job_id })
                  .from(SessionJobOutputReadTable)
                  .where(
                    and(
                      eq(SessionJobOutputReadTable.session_id, sessionID),
                      gt(SessionJobOutputReadTable.expires_at, now),
                    ),
                  )
                  .all()).map((row) => row.jobID),
              )
              const cutoff = now - 7 * 24 * 60 * 60 * 1000
              const selected = rows
                .filter((row) => row.notification_state === "delivered" && !leases.has(row.id))
                .reduce(
                  (result, row) => {
                    if ((row.time_completed ?? row.time_updated) >= cutoff && result.freed >= needed) return result
                    return { rows: [...result.rows, row], freed: result.freed + row.output_bytes }
                  },
                  { rows: [] as Row[], freed: 0 },
                ).rows
              if (selected.length === 0) return []
              return yield* tx
                .update(SessionJobTable)
                .set({ output_deleting: true, time_updated: now })
                .where(
                  and(
                    eq(SessionJobTable.session_id, sessionID),
                    inArray(
                      SessionJobTable.id,
                      selected.map((row) => row.id),
                    ),
                    eq(SessionJobTable.notification_state, "delivered"),
                    eq(SessionJobTable.output_deleting, false),
                  ),
                )
                .returning()
                .all()
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    const completeRetention: Interface["completeRetention"] = Effect.fn("SessionJobStore.completeRetention")(
      function* (sessionID, jobID, deleted) {
        yield* db
          .update(SessionJobTable)
          .set({
            output_deleting: false,
            ...(deleted ? { output_expired: true } : {}),
            time_updated: Date.now(),
          })
          .where(
            and(
              eq(SessionJobTable.session_id, sessionID),
              eq(SessionJobTable.id, jobID),
              eq(SessionJobTable.output_deleting, true),
            ),
          )
          .run()
          .pipe(Effect.orDie)
      },
    )

    return Service.of({
      submit,
      list,
      get,
      claimLaunch,
      markRunning,
      progress,
      finish,
      abandon,
      reconcile,
      reconcileOwned,
      claimNotifications,
      releaseClaim,
      reserveAdmission,
      markAdmitted,
      markObserved,
      markDelivered,
      acquireOutputRead,
      releaseOutputRead,
      retention,
      completeRetention,
    })
  }),
)

function fenced(
  sessionID: SessionID,
  jobID: string,
  runtimeID: string,
  fence: number,
  status: readonly SessionJob.Status[],
) {
  return and(
    eq(SessionJobTable.session_id, sessionID),
    eq(SessionJobTable.id, jobID),
    eq(SessionJobTable.runtime_id, runtimeID),
    eq(SessionJobTable.launch_fence, fence),
    inArray(SessionJobTable.status, status),
  )
}

export function info(row: Row): SessionJob.Info {
  return {
    id: row.id,
    sessionID: row.session_id,
    status: row.status,
    timeout: row.timeout_ms,
    outputBytes: row.output_bytes,
    outputTruncated: row.output_truncated,
    outputExpired: row.output_expired,
    ...(row.exit_code === null ? {} : { exitCode: row.exit_code }),
    ...(row.signal === null ? {} : { signal: row.signal }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    time: {
      created: row.time_created,
      updated: row.time_updated,
      ...(row.time_started === null ? {} : { started: row.time_started }),
      ...(row.time_completed === null ? {} : { completed: row.time_completed }),
    },
  }
}

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node] })

export * as SessionJobStore from "./job-store"
