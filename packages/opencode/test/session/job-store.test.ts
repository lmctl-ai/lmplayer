import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { MessageTable, PartTable, SessionJobTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { eq } from "drizzle-orm"
import { Effect, Exit } from "effect"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { MAX_ACTIVE, MAX_SESSION_OUTPUT, SessionJobStore, info } from "@/session/job-store"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([SessionJobStore.node, SessionProjector.node, EventV2.node, Database.node]), [
    [Database.node, Database.layerFromPath(":memory:")],
  ]),
)

const setup = Effect.fn("SessionJobStoreTest.setup")(function* () {
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
      title: "job test",
      version: "test",
      time_created: Date.now(),
      time_updated: Date.now(),
    })
    .run()
    .pipe(Effect.orDie)
  return sessionID
})

function submission(sessionID: SessionID, callID: string, command = "sleep 1") {
  return {
    sessionID,
    assistantMessageID: "msg_assistant",
    toolCallID: callID,
    command,
    cwd: "/tmp",
    shell: "/bin/sh",
    timeout: 120_000,
    outputPath: `/tmp/${callID}.log`,
  }
}

describe("SessionJobStore", () => {
  it.live(
    "reconciles concurrent exact retries to one durable job",
    Effect.gen(function* () {
      const store = yield* SessionJobStore.Service
      const sessionID = yield* setup()
      const results = yield* Effect.all(
        [store.submit(submission(sessionID, "call-1")), store.submit(submission(sessionID, "call-1"))],
        { concurrency: "unbounded" },
      )
      expect(new Set(results.map((result) => result.row.id)).size).toBe(1)
      expect(results.filter((result) => result.created)).toHaveLength(1)
      expect(yield* store.list(sessionID)).toHaveLength(1)
    }),
  )

  it.live(
    "rejects conflicting reuse of a submission identity",
    Effect.gen(function* () {
      const store = yield* SessionJobStore.Service
      const sessionID = yield* setup()
      yield* store.submit(submission(sessionID, "call-1"))
      const exit = yield* store.submit(submission(sessionID, "call-1", "different")).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* store.list(sessionID)).toHaveLength(1)
    }),
  )

  it.live(
    "serializes the active-job cap under concurrent submissions",
    Effect.gen(function* () {
      const store = yield* SessionJobStore.Service
      const sessionID = yield* setup()
      const exits = yield* Effect.forEach(
        Array.from({ length: MAX_ACTIVE + 2 }, (_, index) => index),
        (index) => store.submit(submission(sessionID, `call-${index}`)).pipe(Effect.exit),
        { concurrency: "unbounded" },
      )
      expect(exits.filter(Exit.isSuccess)).toHaveLength(MAX_ACTIVE)
      expect(yield* store.list(sessionID)).toHaveLength(MAX_ACTIVE)
    }),
  )

  it.live(
    "fences stale launch callbacks",
    Effect.gen(function* () {
      const store = yield* SessionJobStore.Service
      const sessionID = yield* setup()
      const submitted = yield* store.submit(submission(sessionID, "call-1"))
      const claimed = yield* store.claimLaunch(sessionID, submitted.row.id, "runtime-current", process.pid)
      expect(claimed).toBeDefined()
      if (!claimed) return yield* Effect.die("launch claim unexpectedly failed")
      expect(yield* store.markRunning(sessionID, submitted.row.id, "runtime-stale", claimed.launch_fence)).toBe(false)
      expect(yield* store.markRunning(sessionID, submitted.row.id, "runtime-current", claimed.launch_fence - 1)).toBe(
        false,
      )
      expect(yield* store.markRunning(sessionID, submitted.row.id, "runtime-current", claimed.launch_fence)).toBe(true)
    }),
  )

  it.live(
    "allows exactly one concurrent launch claimant",
    Effect.gen(function* () {
      const store = yield* SessionJobStore.Service
      const sessionID = yield* setup()
      const submitted = yield* store.submit(submission(sessionID, "call-launch-race"))
      const claims = yield* Effect.all(
        [
          store.claimLaunch(sessionID, submitted.row.id, "runtime", process.pid),
          store.claimLaunch(sessionID, submitted.row.id, "runtime", process.pid),
        ],
        { concurrency: "unbounded" },
      )
      expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1)
      expect((yield* store.get(sessionID, submitted.row.id)).launch_fence).toBe(1)
    }),
  )

  it.live(
    "stores an omitted timeout as an unbounded launch deadline",
    Effect.gen(function* () {
      const store = yield* SessionJobStore.Service
      const sessionID = yield* setup()
      const submitted = yield* store.submit({
        ...submission(sessionID, "call-unbounded"),
        timeout: undefined,
      })
      expect(submitted.row.timeout_ms).toBe(0)
      const claimed = yield* store.claimLaunch(sessionID, submitted.row.id, "runtime", process.pid)
      expect(claimed?.deadline_at).toBeNull()
      expect(claimed && "timeout" in info(claimed)).toBe(false)
    }),
  )

  it.live(
    "reconciles abandoned launches and expired notification claims",
    Effect.gen(function* () {
      const store = yield* SessionJobStore.Service
      const { db } = yield* Database.Service
      const sessionID = yield* setup()
      const submitted = yield* store.submit(submission(sessionID, "call-reconcile"))
      expect(yield* store.reconcileStale(sessionID, submitted.row.time_updated + 29_999)).toEqual([])
      expect((yield* store.get(sessionID, submitted.row.id)).status).toBe("queued")
      const reconciled = yield* store.reconcileStale(sessionID, submitted.row.time_updated + 30_000)
      expect(reconciled).toHaveLength(1)
      expect(reconciled[0]?.status).toBe("interrupted")
      expect(reconciled[0]?.error_code).toBe("runtime_shutdown")

      const first = yield* store.claimNotifications(sessionID, "claim-first", 1_000)
      expect(first).toHaveLength(1)
      yield* store.reserveAdmission(sessionID, "claim-first", "reserved-batch", "msg_reserved")
      expect(yield* store.claimNotifications(sessionID, "claim-too-soon", 10_000)).toHaveLength(0)
      // A lease expiring alone must not release the claim while its holder is
      // still alive (this test process, in this case) - only a confirmed-dead
      // claimant should be reclaimable. See the dedicated test below for the
      // full alive-vs-dead comparison; this just guards the happy path here
      // still requires the claimant to actually be gone.
      expect(yield* store.claimNotifications(sessionID, "claim-while-alive", 32_000)).toHaveLength(0)
      const deadPID = 2_147_483_647
      yield* db
        .update(SessionJobTable)
        .set({ notification_claim_pid: deadPID })
        .where(eq(SessionJobTable.id, submitted.row.id))
        .run()
        .pipe(Effect.orDie)
      const recovered = yield* store.claimNotifications(sessionID, "claim-recovered", 32_000)
      expect(recovered).toHaveLength(1)
      expect(recovered[0]?.notification_claim_token).toBe("claim-recovered")
      expect(recovered[0]?.notification_batch_id).toBe("reserved-batch")
      expect(recovered[0]?.notification_message_id).toBe("msg_reserved")
      yield* store.reconcileStale(sessionID, 61_999)
      expect((yield* store.get(sessionID, submitted.row.id)).notification_claim_token).toBe("claim-recovered")
      // claim-recovered is now held by this (alive) test process too -
      // simulate it dying before the next reclaim attempt.
      yield* db
        .update(SessionJobTable)
        .set({ notification_claim_pid: deadPID })
        .where(eq(SessionJobTable.id, submitted.row.id))
        .run()
        .pipe(Effect.orDie)
      yield* store.reconcileStale(sessionID, 62_001)
      const restarted = yield* store.claimNotifications(sessionID, "claim-after-restart", 32_001)
      expect(restarted).toHaveLength(1)
      expect(restarted[0]?.notification_claim_token).toBe("claim-after-restart")
    }),
  )

  it.live(
    "preserves a terminal job owned by an exited runtime during reconciliation",
    Effect.gen(function* () {
      const store = yield* SessionJobStore.Service
      const sessionID = yield* setup()
      const deadPID = 2_147_483_647
      const deadPIDAvailable = yield* Effect.sync(() => {
        try {
          process.kill(deadPID, 0)
          return false
        } catch (error) {
          if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return true
          throw error
        }
      })
      expect(deadPIDAvailable).toBe(true)
      const submitted = yield* store.submit(submission(sessionID, "call-terminal-dead-owner"))
      const claimed = yield* store.claimLaunch(sessionID, submitted.row.id, "dead-runtime", deadPID)
      if (!claimed) return yield* Effect.die("terminal job launch claim unexpectedly failed")
      yield* store.markRunning(sessionID, claimed.id, "dead-runtime", claimed.launch_fence, deadPID)
      yield* store.finish({
        sessionID,
        jobID: claimed.id,
        runtimeID: "dead-runtime",
        fence: claimed.launch_fence,
        status: "completed",
        exitCode: 0,
        outputBytes: 0,
        outputTruncated: false,
        droppedBytes: 0,
      })
      yield* store.claimNotifications(sessionID, "terminal-claim", Date.now())
      yield* store.markAdmitted(sessionID, "terminal-claim", "terminal-batch", "msg_terminal")
      yield* store.markDelivered(sessionID, "terminal-batch")

      const before = yield* store.get(sessionID, claimed.id)
      yield* store.reconcileStale(sessionID)
      const after = yield* store.get(sessionID, claimed.id)

      expect(after.status).toBe(before.status)
      expect(after.error_code).toBe(before.error_code)
      expect(after.notification_state).toBe(before.notification_state)
      expect(after.status).toBe("completed")
      expect(after.error_code).toBeNull()
      expect(after.notification_state).toBe("delivered")
    }),
  )

  it.live(
    "protects output retention until its notification is delivered",
    Effect.gen(function* () {
      const store = yield* SessionJobStore.Service
      const sessionID = yield* setup()
      const submitted = yield* store.submit(submission(sessionID, "call-retention"))
      const claimed = yield* store.claimLaunch(sessionID, submitted.row.id, "runtime", process.pid)
      if (!claimed) return yield* Effect.die("launch claim unexpectedly failed")
      yield* store.markRunning(sessionID, claimed.id, "runtime", claimed.launch_fence)
      yield* store.finish({
        sessionID,
        jobID: claimed.id,
        runtimeID: "runtime",
        fence: claimed.launch_fence,
        status: "completed",
        exitCode: 0,
        outputBytes: 8,
        outputTruncated: false,
        droppedBytes: 0,
      })
      expect(yield* store.retention(sessionID, MAX_SESSION_OUTPUT)).toEqual([])

      const rows = yield* store.claimNotifications(sessionID, "claim", Date.now())
      expect(rows).toHaveLength(1)
      yield* store.markAdmitted(sessionID, "claim", "batch", "msg_job_batch")
      yield* store.markDelivered(sessionID, "batch")
      expect(yield* store.acquireOutputRead(sessionID, claimed.id, "reader", Date.now() + 60_000)).toBe(true)
      expect(yield* store.retention(sessionID, MAX_SESSION_OUTPUT)).toEqual([])
      yield* store.releaseOutputRead(sessionID, claimed.id, "reader")
      const firstDeletion = yield* store.retention(sessionID, MAX_SESSION_OUTPUT)
      expect(firstDeletion.map((row) => row.output_path)).toEqual([claimed.output_path])
      const firstToken = firstDeletion[0]?.output_delete_token
      if (!firstToken) return yield* Effect.die("first output deletion token was not assigned")
      expect((yield* store.get(sessionID, claimed.id)).output_deleting).toBe(true)
      yield* store.reconcileStale(sessionID)
      expect((yield* store.get(sessionID, claimed.id)).output_deleting).toBe(true)
      yield* store.reconcileStale(sessionID, Date.now() + 30_001)
      expect((yield* store.get(sessionID, claimed.id)).output_deleting).toBe(false)
      const secondDeletion = yield* store.retention(sessionID, MAX_SESSION_OUTPUT)
      expect(secondDeletion).toHaveLength(1)
      const secondToken = secondDeletion[0]?.output_delete_token
      if (!secondToken) return yield* Effect.die("second output deletion token was not assigned")
      expect(secondToken).not.toBe(firstToken)
      yield* store.completeRetention(sessionID, claimed.id, firstToken, true)
      const stillDeleting = yield* store.get(sessionID, claimed.id)
      expect(stillDeleting.output_deleting).toBe(true)
      expect(stillDeleting.output_expired).toBe(false)
      expect(stillDeleting.output_delete_token).toBe(secondToken)
      yield* store.completeRetention(sessionID, claimed.id, secondToken, false)
      expect((yield* store.get(sessionID, claimed.id)).output_expired).toBe(false)
      const thirdDeletion = yield* store.retention(sessionID, MAX_SESSION_OUTPUT)
      expect(thirdDeletion).toHaveLength(1)
      const thirdToken = thirdDeletion[0]?.output_delete_token
      if (!thirdToken) return yield* Effect.die("third output deletion token was not assigned")
      yield* store.completeRetention(sessionID, claimed.id, thirdToken, true)
      expect((yield* store.get(sessionID, claimed.id)).output_expired).toBe(true)
    }),
  )

  it.live(
    "atomically admits the typed notification part with its claimed jobs",
    Effect.gen(function* () {
      const store = yield* SessionJobStore.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const sessionID = yield* setup()
      const submitted = yield* store.submit(submission(sessionID, "call-notification"))
      const launch = yield* store.claimLaunch(sessionID, submitted.row.id, "runtime", process.pid)
      if (!launch) return yield* Effect.die("launch claim unexpectedly failed")
      yield* store.markRunning(sessionID, launch.id, "runtime", launch.launch_fence)
      yield* store.finish({
        sessionID,
        jobID: launch.id,
        runtimeID: "runtime",
        fence: launch.launch_fence,
        status: "completed",
        exitCode: 0,
        outputBytes: 0,
        outputTruncated: false,
        droppedBytes: 0,
      })
      yield* store.claimNotifications(sessionID, "claim", Date.now())

      const messageID = MessageID.make("msg_job_atomic")
      const partID = PartID.make("prt_job_atomic")
      const message: typeof MessageTable.$inferInsert = {
        id: messageID,
        session_id: sessionID,
        time_created: Date.now(),
        data: {
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
        } as NonNullable<(typeof MessageTable.$inferInsert)["data"]>,
      }
      yield* db.insert(MessageTable).values(message).run().pipe(Effect.orDie)
      const part = {
        id: partID,
        messageID,
        sessionID,
        type: "session-job-notification" as const,
        batchID: "batch",
        jobs: [{ id: launch.id, status: "completed" as const, exitCode: 0, outputBytes: 0, outputTruncated: false }],
      }
      const failed = yield* events
        .publish(
          SessionV1.Event.PartUpdated,
          { sessionID, part, time: Date.now() },
          {
            commit: () =>
              store
                .markAdmitted(sessionID, "claim", "batch", messageID)
                .pipe(Effect.andThen(Effect.die("simulated admission crash"))),
          },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(failed)).toBe(true)
      expect(
        yield* db.select().from(PartTable).where(eq(PartTable.id, partID)).get().pipe(Effect.orDie),
      ).toBeUndefined()
      expect((yield* store.get(sessionID, launch.id)).notification_state).toBe("claimed")

      yield* events.publish(
        SessionV1.Event.PartUpdated,
        { sessionID, part, time: Date.now() },
        {
          commit: () => store.markAdmitted(sessionID, "claim", "batch", messageID).pipe(Effect.asVoid),
        },
      )
      expect(yield* db.select().from(PartTable).where(eq(PartTable.id, partID)).get().pipe(Effect.orDie)).toBeDefined()
      expect((yield* store.get(sessionID, launch.id)).notification_state).toBe("admitted")
    }),
  )
})
