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
import { describe, expect, test } from "bun:test"
import { Deferred, Effect } from "effect"
import { serialize } from "../../src/server/execution-gate"

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
})
