import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { LockTimeoutError, SqlError, UnknownError } from "effect/unstable/sql/SqlError"
import { SqliteRetry } from "@opencode-ai/core/database/sqlite-retry"

function lockError() {
  return new SqlError({ reason: new LockTimeoutError({ cause: new Error("database is locked") }) })
}

function otherError() {
  return new SqlError({ reason: new UnknownError({ cause: new Error("boom") }) })
}

describe("SqliteRetry.retryOnLock", () => {
  test("retries a transient lock error and succeeds once it clears", async () => {
    let attempts = 0
    const effect = Effect.suspend(() => {
      attempts++
      if (attempts < 3) return Effect.fail(lockError())
      return Effect.succeed("ok")
    })

    const result = await Effect.runPromise(SqliteRetry.retryOnLock(effect))
    expect(result).toBe("ok")
    expect(attempts).toBe(3)
  })

  test("does not retry a non-lock SQL error", async () => {
    let attempts = 0
    const effect = Effect.suspend(() => {
      attempts++
      return Effect.fail(otherError())
    })

    const exit = await Effect.runPromiseExit(SqliteRetry.retryOnLock(effect))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(attempts).toBe(1)
  })

  test("gives up after a bounded number of attempts under sustained contention", async () => {
    let attempts = 0
    const effect = Effect.suspend(() => {
      attempts++
      return Effect.fail(lockError())
    })

    const exit = await Effect.runPromiseExit(SqliteRetry.retryOnLock(effect))
    expect(Exit.isFailure(exit)).toBe(true)
    // 1 initial attempt + LOCK_RETRY_MAX_ATTEMPTS retries, never unbounded
    expect(attempts).toBe(SqliteRetry.LOCK_RETRY_MAX_ATTEMPTS + 1)
  }, 15_000)
})
