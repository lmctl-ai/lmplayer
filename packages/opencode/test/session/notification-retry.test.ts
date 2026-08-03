import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Scope } from "effect"
import { SessionJobNotificationRetry } from "@/session/notification-retry"
import { Runner } from "@/effect/runner"

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

describe("SessionJobNotificationRetry", () => {
  test("serializes simultaneous owner creation from an absent entry", async () => {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const release = yield* Deferred.make<void>()
          let owners = 0
          let active = 0
          let maximumActive = 0
          const owner = yield* SessionJobNotificationRetry.make<string>({
            onOwnerCreated: () => Effect.sync(() => owners++).pipe(Effect.asVoid),
            attempt: () =>
              Effect.gen(function* () {
                active++
                maximumActive = Math.max(maximumActive, active)
                yield* Deferred.await(release)
                active--
                return false
              }),
          })

          yield* Effect.all(
            Array.from({ length: 20 }, () => owner.schedule("session")),
            { concurrency: "unbounded", discard: true },
          )
          expect(owners).toBe(1)
          yield* Deferred.succeed(release, undefined)
          yield* owner.wait("session")
          expect(maximumActive).toBe(1)
        }),
      ),
    )
  })

  test("coalesces concurrent schedules into one owner", async () => {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          let attempts = 0
          let active = 0
          let maximumActive = 0
          const owner = yield* SessionJobNotificationRetry.make<string>({
            attempt: () =>
              Effect.gen(function* () {
                attempts++
                active++
                maximumActive = Math.max(maximumActive, active)
                yield* Deferred.succeed(started, undefined)
                yield* Deferred.await(release)
                active--
                return false
              }),
          })

          yield* owner.schedule("session")
          yield* Deferred.await(started)
          yield* Effect.all(
            Array.from({ length: 19 }, () => owner.schedule("session")),
            {
              concurrency: "unbounded",
              discard: true,
            },
          )
          expect(attempts).toBe(1)
          yield* Deferred.succeed(release, undefined)
          yield* owner.wait("session")
          expect(attempts).toBe(2)
          expect(maximumActive).toBe(1)
        }),
      ),
    )
  })

  test("settles and retries when cancel discards an accepted pending wake", async () => {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Scope.Scope
          const foregroundStarted = yield* Deferred.make<void>()
          const runner = Runner.make<void>(scope)
          const foreground = yield* runner
            .ensureRunning(
              Deferred.succeed(foregroundStarted, undefined).pipe(Effect.andThen(Effect.never), Effect.asVoid),
            )
            .pipe(Effect.exit, Effect.forkChild)
          yield* Deferred.await(foregroundStarted)

          let attempts = 0
          const owner = yield* SessionJobNotificationRetry.make<string>({
            delay: () => Effect.void,
            attempt: () =>
              Effect.gen(function* () {
                attempts++
                const request = yield* runner.requestRun(Effect.void, false)
                if (!request.accepted) return false
                yield* request.settled
                return false
              }),
          })
          yield* owner.schedule("session")
          yield* Effect.gen(function* () {
            while (runner.state._tag !== "Running" || !runner.state.pending) yield* Effect.yieldNow
          }).pipe(Effect.timeout("1 second"))

          yield* runner.cancel
          yield* owner.wait("session").pipe(Effect.timeout("1 second"))
          yield* Fiber.join(foreground)
          expect(attempts).toBe(2)
          expect(owner.isDegraded("session")).toBe(false)
        }),
      ),
    )
  })

  test("settles and rejects retry when disposal discards an accepted pending wake", async () => {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Scope.Scope
          const foregroundStarted = yield* Deferred.make<void>()
          const runner = Runner.make<void>(scope)
          const foreground = yield* runner
            .ensureRunning(
              Deferred.succeed(foregroundStarted, undefined).pipe(Effect.andThen(Effect.never), Effect.asVoid),
            )
            .pipe(Effect.exit, Effect.forkChild)
          yield* Deferred.await(foregroundStarted)

          let attempts = 0
          const owner = yield* SessionJobNotificationRetry.make<string>({
            delay: () => Effect.void,
            attempt: () =>
              Effect.gen(function* () {
                attempts++
                const request = yield* runner.requestRun(Effect.void, false)
                if (!request.accepted) return false
                yield* request.settled
                return false
              }),
          })
          yield* owner.schedule("session")
          yield* Effect.gen(function* () {
            while (runner.state._tag !== "Running" || !runner.state.pending) yield* Effect.yieldNow
          }).pipe(Effect.timeout("1 second"))

          yield* runner.dispose
          yield* owner.wait("session").pipe(Effect.timeout("1 second"))
          yield* Fiber.join(foreground)
          expect(attempts).toBe(2)
          expect(owner.isDegraded("session")).toBe(false)
        }),
      ),
    )
  })

  test("retries a failure in the early lookup or claim phase", async () => {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          let attempts = 0
          const owner = yield* SessionJobNotificationRetry.make<string>({
            attempt: () => (++attempts === 1 ? Effect.fail("lookup failed") : Effect.succeed(false)),
            delay: () => Effect.void,
          })
          yield* owner.schedule("session")
          yield* owner.wait("session")
          expect(attempts).toBe(2)
        }),
      ),
    )
  })

  test("degrades after six failures and recovers when a later user prompt reschedules", async () => {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          let failing = true
          let attempts = 0
          const owner = yield* SessionJobNotificationRetry.make<string>({
            attempt: () => {
              attempts++
              return failing ? Effect.fail("database unavailable") : Effect.succeed(false)
            },
            delay: () => Effect.void,
          })
          yield* owner.schedule("session")
          yield* owner.wait("session")
          expect(attempts).toBe(6)
          expect(owner.isDegraded("session")).toBe(true)

          failing = false
          yield* owner.recover("session")
          yield* owner.wait("session")
          expect(attempts).toBe(7)
          expect(owner.isDegraded("session")).toBe(false)
        }),
      ),
    )
  })
})
