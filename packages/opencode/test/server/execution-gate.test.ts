// Direct unit coverage for the process-global sequential-execution gate
// (execution-gate.ts) itself, isolated from the session/job/prompt machinery
// that calls it. This is the mechanism the single-user sequential-execution
// direction pillar depends on — verify it actually serializes here, once,
// rather than only indirectly through higher-level feature tests.
//
// Deliberately does NOT exercise beginDrain/gracefulShutdown/isDraining: those
// flip module-scope flags with no reset hook, and this module is a true
// process-wide singleton (one semaphore per process, by design — see the
// comment on `executionGate` in execution-gate.ts) - touching draining state
// here would leak into every other test in the same process.
//
// The aggregate turn deadline rides the same singleton. Its per-session
// bookkeeping is cleared by every test that writes it (prompt.ts clears it on
// read in production), so a leaked entry can only make these assertions more
// visible, never less.
import { afterEach, describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { clearSessionTurnTimeout, getSessionTurnTimeout, serialize } from "../../src/server/execution-gate"

const sessionID = "ses_turn_timeout"

function expectTurnTimeoutCause(cause: Cause.Cause<unknown>, timeoutMs: number) {
  const failure = Cause.findErrorOption(cause) as { _tag: "Some"; value: unknown } | { _tag: "None" }
  if (failure._tag !== "Some") throw new Error("expected a typed failure, got a defect or interruption")
  const error = failure.value as { _tag?: string; timeoutMs?: number }
  expect(error._tag).toBe("TurnTimeoutError")
  if (error._tag !== "TurnTimeoutError") throw new Error("expected TurnTimeoutError")
  expect(error.timeoutMs).toBe(timeoutMs)
}

function expectTurnTimeout(exit: Exit.Exit<unknown, unknown>, timeoutMs: number) {
  expect(Exit.isFailure(exit)).toBe(true)
  if (!Exit.isFailure(exit)) throw new Error("expected the turn to fail with the deadline")
  expectTurnTimeoutCause(exit.cause, timeoutMs)
}

// `Effect.exit` inside a forked fiber yields an Exit wrapping the Exit we want
// (Effect.runPromise unwraps the outer one), so peel the inner one here.
function expectTurnTimeoutExit(exit: Exit.Exit<unknown, unknown>, timeoutMs: number) {
  if (!Exit.isSuccess(exit)) throw new Error(`expected the turn to report an exit, got ${exit._tag}`)
  const inner = exit.value
  if (!inner || typeof inner !== "object" || !("_tag" in inner)) throw new Error("expected an effect exit value")
  const result = inner as Exit.Exit<unknown, unknown>
  expect(Exit.isFailure(result)).toBe(true)
  if (!Exit.isFailure(result)) throw new Error("expected the turn to fail with the deadline")
  expectTurnTimeoutCause(result.cause, timeoutMs)
}

// Deadline behavior is driven through the environment for callers that pass no
// explicit option, so keep the variable scoped to one assertion.
function withEnv(name: string, value: string, fx: () => Promise<void>) {
  const previous = process.env[name]
  process.env[name] = value
  return fx().finally(() => {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  })
}

afterEach(() => {
  clearSessionTurnTimeout(sessionID)
})

describe("execution-gate serialize", () => {
  test("a second call queues behind a still-running first call (FIFO, no overlap)", async () => {
    const events: string[] = []
    const started = await Effect.runPromise(Deferred.make<void>())
    const release = await Effect.runPromise(Deferred.make<void>())

    const first = Effect.runPromise(
      serialize(
        Effect.gen(function* () {
          events.push("first:start")
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
          events.push("first:end")
        }),
      ),
    )

    // Wait until `first` actually holds the permit and is mid-flight before
    // queuing `second` - otherwise this would just prove ordinary sequencing,
    // not that the gate holds the permit for the full duration of `first`.
    await Effect.runPromise(Deferred.await(started))

    const second = Effect.runPromise(
      serialize(
        Effect.sync(() => {
          events.push("second:start")
        }),
      ),
    )

    await Effect.runPromise(Deferred.succeed(release, undefined))
    await first
    await second

    // If the gate let `second` run while `first` still held the permit,
    // "second:start" would land between "first:start" and "first:end".
    expect(events).toEqual(["first:start", "first:end", "second:start"])
  })

  test("independent calls each still run their effect exactly once", async () => {
    let calls = 0
    await Effect.runPromise(serialize(Effect.sync(() => calls++)))
    await Effect.runPromise(serialize(Effect.sync(() => calls++)))
    expect(calls).toBe(2)
  })

  test("an expired deadline fails the turn and releases the permit to the queued turn", async () => {
    const events: string[] = []

    await Effect.runPromise(
      Effect.gen(function* () {
        // Fork both turns together so the second is queued while the first still
        // holds the permit: if the deadline failed to release it, the second
        // would never run and this test would hang instead of passing.
        const expiring = yield* serialize(
          Effect.sync(() => events.push("first:start")).pipe(Effect.andThen(Effect.sleep("10 seconds"))),
          { sessionID, timeoutMs: 50 },
        ).pipe(Effect.exit, Effect.forkChild)
        const queued = yield* serialize(
          Effect.sync(() => events.push("second:start")),
          { timeoutMs: 5_000 },
        ).pipe(Effect.forkChild)

        const [expiringExit, queuedExit] = yield* Fiber.awaitAll([expiring, queued])

        expectTurnTimeoutExit(expiringExit, 50)
        expect(Exit.isSuccess(queuedExit)).toBe(true)
        // The interrupted turn never reached its own end, but the queued one ran.
        expect(events).toEqual(["first:start", "second:start"])
      }),
    )
  })

  test("timeoutMs false disables the deadline", async () => {
    const exit = await Effect.runPromise(
      Effect.exit(serialize(Effect.sleep("50 millis").pipe(Effect.as("done")), { timeoutMs: false })),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    if (!Exit.isSuccess(exit)) throw new Error("expected the turn to finish with the deadline disabled")
    expect(exit.value).toBe("done")
  })

  test("LMPLAYER_TURN_TIMEOUT_MS bounds a turn with no explicit deadline", async () => {
    await withEnv("LMPLAYER_TURN_TIMEOUT_MS", "50", async () => {
      await Effect.runPromise(
        serialize(Effect.sleep("10 seconds")).pipe(
          Effect.exit,
          Effect.tap((exit) => Effect.sync(() => expectTurnTimeout(exit, 50))),
        ),
      )
    })
  })

  test("LMPLAYER_TURN_TIMEOUT_MS can disable the deadline", async () => {
    await withEnv("LMPLAYER_TURN_TIMEOUT_MS", "off", async () => {
      const exit = await Effect.runPromise(Effect.exit(serialize(Effect.sleep("50 millis").pipe(Effect.as("done")))))
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) expect(exit.value).toBe("done")
    })
  })

  test("registers the timed-out session for the prompt loop to attribute", async () => {
    expect(getSessionTurnTimeout(sessionID)).toBeUndefined()

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* serialize(Effect.never, { sessionID, timeoutMs: 50 }).pipe(Effect.exit, Effect.forkChild)
        expectTurnTimeoutExit(yield* Fiber.await(fiber), 50)
      }),
    )

    // prompt.ts owns the read-and-clear; assert the write side here.
    expect(getSessionTurnTimeout(sessionID)).toBe(50)
    clearSessionTurnTimeout(sessionID)
    expect(getSessionTurnTimeout(sessionID)).toBeUndefined()
  })

  test("a turn without a session does not record a timed-out session", async () => {
    const exit = await Effect.runPromise(Effect.exit(serialize(Effect.never, { timeoutMs: 50 })))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(getSessionTurnTimeout(sessionID)).toBeUndefined()
  })

  test("runs the deadline cleanup before failing the turn", async () => {
    let cleaned = 0
    const exit = await Effect.runPromise(
      Effect.exit(
        serialize(Effect.never, {
          timeoutMs: 50,
          // Callers abort the underlying turn here; the failure must still carry
          // the deadline after cleanup runs.
          onDeadline: Effect.sync(() => {
            cleaned++
          }),
        }),
      ),
    )
    expect(cleaned).toBe(1)
    expectTurnTimeout(exit, 50)
  })
})
