export * as SqliteRetry from "./sqlite-retry"

import { Duration, Effect, Schedule } from "effect"
import { LockTimeoutError, type SqlError } from "effect/unstable/sql/SqlError"

// A single opencode host runs many concurrent opencode processes (one per
// lmctl-managed session) against the same on-disk SQLite file. WAL mode
// allows concurrent readers, but writes still serialize - under enough
// concurrent writers, SQLite's own busy_timeout can still be exhausted and
// return SQLITE_BUSY/SQLITE_LOCKED ("database is locked"), which otherwise
// surfaces to the ACP client as a fatal, session-ending error even though
// the data is fine and the same statement would likely succeed moments
// later. Retry that specific, transient failure class before giving up.
export const LOCK_RETRY_BASE_DELAY = Duration.millis(50)
export const LOCK_RETRY_FACTOR = 2
export const LOCK_RETRY_MAX_ATTEMPTS = 6

const lockRetrySchedule = Schedule.both(
  Schedule.exponential(LOCK_RETRY_BASE_DELAY, LOCK_RETRY_FACTOR),
  Schedule.recurs(LOCK_RETRY_MAX_ATTEMPTS),
).pipe(Schedule.jittered)

export function retryOnLock<A, E extends SqlError, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  return effect.pipe(
    Effect.retry({
      schedule: lockRetrySchedule,
      while: (error) => error.cause instanceof LockTimeoutError,
    }),
  )
}
