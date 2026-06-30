import { Duration, Effect, Semaphore } from "effect"
import { HttpApiError } from "effect/unstable/httpapi"

// Process-global FIFO execution gate. lmcode is single-user + sequential: only
// ONE agent run (prompt/command/init/summarize/shell/import) may execute at a
// time across the whole server; concurrent execution requests queue (Effect
// grants semaphore permits FIFO) and run one after another. Module scope = one
// permit per process (truly global, independent of instance/location).
//
// IMPORTANT: this gate lives strictly at the HTTP handler boundary. Subagents
// (tool/task.ts) re-enter execution in-process via `ops.prompt`, NOT through
// these handlers, so they bypass the gate — moving it deeper (into
// SessionPrompt/Runner) would deadlock (parent holds the permit while the child
// waits forever). Read-only and control endpoints stay ungated so they never
// block behind a run.
const executionGate = Semaphore.makeUnsafe(1)

let draining = false

export function isDraining() {
  return draining
}

// Wrap an execution effect so it runs under the single global permit. Once a
// drain has started, new wrapped requests fail fast with a 503 (the in-flight
// run that already holds the permit is NOT interrupted — see beginDrain).
//
// The pre-permit `draining` check is only a fast path. The AUTHORITATIVE check
// happens AFTER the permit is acquired: because the gate is FIFO, a request that
// slipped past the fast-path check just before drain started will still acquire
// the permit BEFORE beginDrain's own `withPermits(1)` (it queued first), see
// draining=true at that point, and reject with 503 without ever running. This
// closes the race where a request passes the pre-check between drain flip and
// permit acquisition. The single in-flight holder that already had the permit
// when drain started is unaffected and finishes normally (beginDrain waits).
export const serialize = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | HttpApiError.ServiceUnavailable, R> =>
  Effect.suspend(
    (): Effect.Effect<A, E | HttpApiError.ServiceUnavailable, R> =>
      draining
        ? Effect.fail(new HttpApiError.ServiceUnavailable())
        : executionGate.withPermits(1)(
            Effect.suspend(
              (): Effect.Effect<A, E | HttpApiError.ServiceUnavailable, R> =>
                draining ? Effect.fail(new HttpApiError.ServiceUnavailable()) : effect,
            ),
          ),
  )

// Graceful drain: flip the draining flag so new runs are rejected, then WAIT for
// the permit — i.e. block until any in-flight run finishes and releases it. The
// in-flight run completes normally; it is never interrupted.
export const beginDrain = Effect.fnUntraced(function* () {
  draining = true
  yield* executionGate.withPermits(1)(Effect.void)
})

// Generous safety cap so a wedged run can't block exit forever. The drain waits
// for the in-flight run to finish on its own (no interruption); this only bounds
// pathological hangs.
const DRAIN_TIMEOUT = Duration.minutes(10)

let shuttingDown = false

// Shared drain-then-exit routine, triggered by SIGTERM/SIGINT or POST /shutdown.
// Idempotent (guards against double-trigger). Sets the draining flag SYNCHRONOUSLY
// so new runs are rejected (503) right away, then — after a short grace so any
// just-sent HTTP response flushes — waits for the in-flight run to finish on the
// global gate (it is NOT interrupted) and force-exits.
export function gracefulShutdown(reason: string) {
  if (shuttingDown) return
  shuttingDown = true
  draining = true
  console.log(`draining (${reason}); waiting for in-flight run to finish (timeout ${Duration.format(DRAIN_TIMEOUT)})`)
  Effect.runPromise(Effect.sleep("100 millis").pipe(Effect.andThen(beginDrain()), Effect.timeout(DRAIN_TIMEOUT)))
    .then(() => console.log("drain complete; exiting"))
    .catch(() => console.log("drain timeout exceeded; exiting anyway"))
    .finally(() => process.exit(0))
}
