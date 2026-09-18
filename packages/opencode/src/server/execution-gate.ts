import { Cause, Duration, Effect, Option, Semaphore } from "effect"
import { Config } from "@/config/config"
import { HttpApiError } from "effect/unstable/httpapi"
import { TurnTimeoutError } from "./routes/instance/httpapi/errors"

// Process-global FIFO execution gate. lmplayer is single-user + sequential: only
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

// Aggregate wall-clock deadline for one gated turn. The transport-level provider
// bounds (header/chunk/total in provider/provider.ts) only cover time spent
// waiting on the provider's HTTP response; a turn can also wedge in a tool loop,
// a lock, a subagent, or a stalled event loop, and while it does it holds the
// single gate permit — which wedges every other request and drain in the server.
// This is the backstop for everything outside the provider stream.
export const TURN_TIMEOUT_DEFAULT_MS = 45 * 60 * 1000

// Turns that were cancelled by the deadline above, keyed by session. The prompt
// loop reads this in finalizeInterruptedAssistant so an interrupted turn is
// recorded as an explicit TurnTimeoutError instead of a bare abort. Entries are
// removed by that read (or by clearSessionTurnTimeout).
const timedOutSessions = new Map<string, number>()

export function getSessionTurnTimeout(sessionID: string): number | undefined {
  return timedOutSessions.get(sessionID)
}

export function clearSessionTurnTimeout(sessionID: string): void {
  timedOutSessions.delete(sessionID)
}

export function setSessionTurnTimeout(sessionID: string, timeoutMs: number): void {
  timedOutSessions.set(sessionID, timeoutMs)
  // Auto-cleanup after 30s as a safety ceiling so an unconsumed entry
  // can never leak onto an unrelated later abort of the same session.
  const timer = setTimeout(() => timedOutSessions.delete(sessionID), 30_000)
  timer.unref?.()
}

let draining = false

export function isDraining() {
  return draining
}

export interface SerializeOptions {
  readonly sessionID?: string
  readonly timeoutMs?: number | false
  /**
   * Best-effort cleanup run after the deadline expires, before the caller sees
   * `TurnTimeoutError`. This is where a caller aborts the underlying turn so its
   * own cleanup (finalizing the assistant message, releasing run state) actually
   * executes: interrupting the caller's fiber alone would leave the turn running
   * in the background and never mark the message. Failures and defects here are
   * ignored — the deadline still fails the turn either way.
   */
  readonly onDeadline?: Effect.Effect<unknown, unknown>
}

// Environment escape hatch, checked before config and after per-call options.
// Accepts the same "off" spellings as an explicit `false` so an operator can
// disable the deadline for a long-running deployment without editing config.
const TIMEOUT_ENV_VARS = ["LMPLAYER_TURN_TIMEOUT_MS", "OPENCODE_TURN_TIMEOUT_MS"] as const
const TIMEOUT_OFF = new Set(["false", "0", "none", "off"])

function envTurnTimeout(): number | false | undefined {
  for (const name of TIMEOUT_ENV_VARS) {
    const value = process.env[name]?.trim().toLowerCase()
    if (!value) continue
    if (TIMEOUT_OFF.has(value)) return false
    const parsed = Number.parseInt(value, 10)
    if (!Number.isNaN(parsed)) return parsed
  }
  return undefined
}

// Resolve the deadline for one turn. Precedence: per-call option, then env, then
// config (`turn_timeout_ms`), then the default. `false` (or a non-positive value)
// disables the deadline entirely.
const turnTimeout = Effect.fnUntraced(function* (options?: SerializeOptions) {
  if (options?.timeoutMs !== undefined) return options.timeoutMs
  const fromEnv = envTurnTimeout()
  if (fromEnv !== undefined) return fromEnv
  const configSvc = yield* Effect.serviceOption(Config.Service)
  if (Option.isNone(configSvc)) return TURN_TIMEOUT_DEFAULT_MS
  const configured = yield* configSvc.value.get().pipe(Effect.orElseSucceed(() => undefined))
  return configured?.turn_timeout_ms ?? TURN_TIMEOUT_DEFAULT_MS
})

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
//
// The deadline is applied INSIDE the permit so the timer covers the actual run
// and not the time spent queued behind another turn, and so expiry interrupts
// the caller's fiber tree and releases the permit. The turn's session (when
// known) is recorded before failing so prompt.ts can attribute the interruption,
// and `onDeadline` (when provided) aborts the underlying turn so its cleanup
// runs instead of leaving the work orphaned.
export const serialize = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options?: SerializeOptions,
): Effect.Effect<A, E | HttpApiError.ServiceUnavailable | TurnTimeoutError, R> =>
  Effect.suspend(
    (): Effect.Effect<A, E | HttpApiError.ServiceUnavailable | TurnTimeoutError, R> =>
      draining
        ? Effect.fail(new HttpApiError.ServiceUnavailable())
        : executionGate.withPermits(1)(
            Effect.suspend(
              (): Effect.Effect<A, E | HttpApiError.ServiceUnavailable | TurnTimeoutError, R> =>
                draining
                  ? Effect.fail(new HttpApiError.ServiceUnavailable())
                  : Effect.gen(function* () {
                      const timeoutMs = yield* turnTimeout(options)
                      if (timeoutMs === false || timeoutMs <= 0) return yield* effect
                      return yield* effect.pipe(
                        Effect.timeoutOrElse({
                          duration: Duration.millis(timeoutMs),
                          orElse: () =>
                            Effect.gen(function* () {
                              if (options?.sessionID) setSessionTurnTimeout(options.sessionID, timeoutMs)
                              yield* Effect.logError("turn execution timed out", {
                                sessionID: options?.sessionID,
                                timeoutMs,
                              })
                              if (options?.onDeadline)
                                yield* options.onDeadline.pipe(
                                  Effect.catchCause((cause) =>
                                    Effect.logError("turn deadline cleanup failed", { cause: Cause.pretty(cause) }),
                                  ),
                                )
                              return yield* new TurnTimeoutError({
                                message: `Turn execution exceeded aggregate deadline of ${timeoutMs}ms`,
                                timeoutMs,
                              })
                            }),
                        }),
                      )
                    }),
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

// Bounded window for SessionJobRuntime.shutdown() below — same cap the one-shot
// CLI path uses (index.ts) for the identical reason: some background-job
// subprocesses (e.g. docker-based MCP servers without `--init`) don't react to
// SIGTERM promptly, so this can't be unbounded without risking a hung exit.
const JOB_SHUTDOWN_TIMEOUT = Duration.seconds(10)

// Shared drain-then-exit routine, triggered by SIGTERM/SIGINT or POST /shutdown.
// Idempotent (guards against double-trigger). Sets the draining flag SYNCHRONOUSLY
// so new runs are rejected (503) right away, then — after a short grace so any
// just-sent HTTP response flushes — waits for the in-flight run to finish on the
// global gate (it is NOT interrupted), terminates this process's own background
// session jobs (mirrors the one-shot CLI path in index.ts — without this, a
// `serve` SIGTERM left detached job processes as untracked orphans, since only
// the one-shot exit path ever called SessionJobRuntime.shutdown()), and force-exits.
export function gracefulShutdown(reason: string) {
  if (shuttingDown) return
  shuttingDown = true
  draining = true
  console.log(`draining (${reason}); waiting for in-flight run to finish (timeout ${Duration.format(DRAIN_TIMEOUT)})`)
  Effect.runPromise(Effect.sleep("100 millis").pipe(Effect.andThen(beginDrain()), Effect.timeout(DRAIN_TIMEOUT)))
    .then(() => console.log("drain complete; shutting down background jobs"))
    .catch(() => console.log("drain timeout exceeded; shutting down background jobs anyway"))
    .then(shutdownJobs)
    .finally(() => process.exit(0))
}

async function shutdownJobs() {
  const { AppRuntime } = await import("@/effect/app-runtime")
  const { SessionJobRuntime } = await import("@/session/job-runtime")
  const result = await Promise.race([
    AppRuntime.runPromise(SessionJobRuntime.Service.pipe(Effect.flatMap((service) => service.shutdown()))).then(
      () => ({ type: "complete" as const }),
      (error: unknown) => ({ type: "failed" as const, error }),
    ),
    new Promise<{ type: "timeout" }>((resolve) =>
      setTimeout(() => resolve({ type: "timeout" }), Duration.toMillis(JOB_SHUTDOWN_TIMEOUT)),
    ),
  ])
  if (result.type === "failed") console.log(`background job shutdown failed: ${String(result.error)}`)
  if (result.type === "timeout") console.log("background job shutdown exceeded 10 seconds; exiting anyway")
}
