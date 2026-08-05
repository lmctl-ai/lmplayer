import { describe, expect, test } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Deferred, Effect, Exit, Ref } from "effect"
import { TestClock } from "effect/testing"
import { MAX_CRON_JOBS_PER_SESSION, RECURRING_LIFETIME, SessionCronRuntime, matchesCron } from "@/session/cron-runtime"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([SessionCronRuntime.node])))

describe("SessionCronRuntime", () => {
  test("matches standard five-field expressions in local time", () => {
    expect(matchesCron("*/5 9-17 * * 1-5", new Date(2026, 0, 5, 9, 10))).toBe(true)
    expect(matchesCron("*/5 9-17 * * 1-5", new Date(2026, 0, 5, 9, 12))).toBe(false)
    expect(matchesCron("*/5 9-17 * * 1-5", new Date(2026, 0, 4, 9, 10))).toBe(false)
    expect(matchesCron("0 0 1 * 1", new Date(2026, 0, 5, 0, 0))).toBe(true)
    expect(matchesCron("0 0 1 * 1", new Date(2026, 0, 1, 0, 0))).toBe(true)
    expect(matchesCron("0 0 * * 7", new Date(2026, 0, 4, 0, 0))).toBe(true)
    expect(matchesCron("0 0 1-31 * 1", new Date(2026, 0, 6, 0, 0))).toBe(true)
    expect(matchesCron("0 0 */1 * 1", new Date(2026, 0, 6, 0, 0))).toBe(false)
    expect(matchesCron("0 0 */1 * 1", new Date(2026, 0, 5, 0, 0))).toBe(true)
  })

  it.effect(
    "checks registered jobs on the process-wide timer",
    Effect.gen(function* () {
      const runtime = yield* SessionCronRuntime.Service
      const fired = yield* Deferred.make<void>()
      yield* runtime.setWake(() => Deferred.succeed(fired, undefined).pipe(Effect.as(true)))
      yield* runtime.create(SessionID.make("ses_cron_timer"), {
        cron: "* * * * *",
        prompt: "timer check",
        recurring: false,
      })

      yield* Effect.yieldNow
      yield* TestClock.adjust("30 seconds")
      yield* Deferred.await(fired)
    }),
  )

  it.effect(
    "keeps a due job pending while busy and fires it once idle",
    Effect.gen(function* () {
      const runtime = yield* SessionCronRuntime.Service
      const sessionID = SessionID.make("ses_cron_idle")
      const busy = yield* Ref.make(true)
      const prompts = yield* Ref.make<string[]>([])
      yield* runtime.setWake((owner, prompt) =>
        Effect.gen(function* () {
          if (yield* Ref.get(busy)) return false
          yield* Ref.update(prompts, (items) => [...items, `${owner}:${prompt}`])
          return true
        }),
      )
      const job = yield* runtime.create(sessionID, { cron: "* * * * *", prompt: "check status" })

      yield* runtime.tick(job.createdAt)
      expect((yield* runtime.list(sessionID))[0]?.lastFiredAt).toBeUndefined()
      yield* Ref.set(busy, false)
      yield* runtime.tick(job.createdAt)
      yield* runtime.tick(job.createdAt + 20_000)

      expect(yield* Ref.get(prompts)).toEqual([`${sessionID}:check status`])
      expect((yield* runtime.list(sessionID))[0]?.lastFiredAt).toBe(job.createdAt)
    }),
  )

  it.effect(
    "prunes recurring jobs at the seven-day bound before matching or firing",
    Effect.gen(function* () {
      const runtime = yield* SessionCronRuntime.Service
      const sessionID = SessionID.make("ses_cron_expiry")
      const fires = yield* Ref.make(0)
      yield* runtime.setWake(() => Ref.update(fires, (count) => count + 1).pipe(Effect.as(true)))
      const job = yield* runtime.create(sessionID, { cron: "* * * * *", prompt: "expire me" })
      yield* runtime.create(sessionID, { cron: "0 0 1 2 *", prompt: "not due at expiry" })

      yield* runtime.tick(job.createdAt)
      expect(yield* Ref.get(fires)).toBe(1)
      expect(yield* runtime.list(sessionID)).toHaveLength(2)
      yield* runtime.tick(job.createdAt + RECURRING_LIFETIME)

      expect(yield* Ref.get(fires)).toBe(1)
      expect(yield* runtime.list(sessionID)).toHaveLength(0)
    }),
  )

  it.effect(
    "fires a non-recurring job once and automatically removes it",
    Effect.gen(function* () {
      const runtime = yield* SessionCronRuntime.Service
      const sessionID = SessionID.make("ses_cron_once")
      const fires = yield* Ref.make(0)
      yield* runtime.setWake(() => Ref.update(fires, (count) => count + 1).pipe(Effect.as(true)))
      const job = yield* runtime.create(sessionID, {
        cron: "* * * * *",
        prompt: "once",
        recurring: false,
      })

      yield* runtime.tick(job.createdAt)
      yield* runtime.tick(job.createdAt + 60_000)

      expect(yield* Ref.get(fires)).toBe(1)
      expect(yield* runtime.list(sessionID)).toHaveLength(0)
    }),
  )

  it.effect(
    "stores and deletes session-scoped jobs without a Database service",
    Effect.gen(function* () {
      const runtime = yield* SessionCronRuntime.Service
      const owner = SessionID.make("ses_cron_owner")
      const other = SessionID.make("ses_cron_other")
      const job = yield* runtime.create(owner, { cron: "0 9 * * 1-5", prompt: "daily check" })

      expect(yield* runtime.list(owner)).toEqual([job])
      expect(yield* runtime.list(other)).toEqual([])
      expect(Exit.isFailure(yield* runtime.remove(other, job.id).pipe(Effect.exit))).toBe(true)
      expect((yield* runtime.remove(owner, job.id)).id).toBe(job.id)
      expect(yield* runtime.list(owner)).toEqual([])

      yield* runtime.create(owner, { cron: "0 9 * * 1-5", prompt: "owner only" })
      const retained = yield* runtime.create(other, { cron: "0 9 * * 1-5", prompt: "other session" })
      yield* runtime.removeSession(owner)
      expect(yield* runtime.list(owner)).toEqual([])
      expect(yield* runtime.list(other)).toEqual([retained])
    }),
  )

  it.effect(
    "rejects an invalid cron expression",
    Effect.gen(function* () {
      const runtime = yield* SessionCronRuntime.Service
      const exit = yield* runtime
        .create(SessionID.make("ses_cron_invalid"), { cron: "61 * * * *", prompt: "bad" })
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.effect(
    "caps active cron jobs per session",
    Effect.gen(function* () {
      const runtime = yield* SessionCronRuntime.Service
      const sessionID = SessionID.make("ses_cron_limit")
      yield* Effect.forEach(
        Array.from({ length: MAX_CRON_JOBS_PER_SESSION }),
        (_, index) => runtime.create(sessionID, { cron: "* * * * *", prompt: `job ${index}` }),
        { discard: true },
      )

      const exit = yield* runtime.create(sessionID, { cron: "* * * * *", prompt: "one too many" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toHaveProperty(
          "message",
          `A session may have at most ${MAX_CRON_JOBS_PER_SESSION} active cron jobs`,
        )
      }
      expect(yield* runtime.list(sessionID)).toHaveLength(MAX_CRON_JOBS_PER_SESSION)
      const otherSessionID = SessionID.make("ses_cron_limit_other")
      expect(
        (yield* runtime.create(otherSessionID, {
          cron: "* * * * *",
          prompt: "other session still has capacity",
        })).sessionID,
      ).toBe(otherSessionID)
    }),
  )
})
