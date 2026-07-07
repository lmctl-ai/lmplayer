// Unit tests for the non-interactive `run` false-success guard.
//
// Regression for the lmctl / lmplayerdev seq30 report: a non-interactive run
// that finishes consuming the event stream WITHOUT observing a terminal
// `session.status: idle` or `session.error` used to return cleanly (exit 0,
// empty JSON) on a turn that never reached a terminal state. `resolveRunCompletion`
// now falls back to a direct session-status check in that case.
import { describe, expect, test } from "bun:test"
import { resolveRunCompletion, type ActiveStatus } from "@/cli/cmd/run/completion"

describe("resolveRunCompletion", () => {
  test("returns idle when the stream observed a terminal idle status", async () => {
    let lookups = 0
    const resolution = await resolveRunCompletion({
      result: { error: undefined, idle: true },
      activeStatus: async () => {
        lookups += 1
        return undefined
      },
    })
    expect(resolution).toBe("idle")
    // A terminal idle was observed; no fallback status lookup should happen.
    expect(lookups).toBe(0)
  })

  test("returns error when the stream surfaced a session error", async () => {
    let lookups = 0
    const resolution = await resolveRunCompletion({
      result: { error: "provider exploded", idle: false },
      activeStatus: async () => {
        lookups += 1
        return undefined
      },
    })
    expect(resolution).toBe("error")
    expect(lookups).toBe(0)
  })

  // The core regression: stream ended before idle/error, and the follow-up
  // status check shows the session is still active. Must be reported as
  // incomplete so the caller exits nonzero instead of a false success.
  test("returns incomplete when the stream ends before idle and the session is still busy", async () => {
    const resolution = await resolveRunCompletion({
      result: { error: undefined, idle: false },
      activeStatus: async () => ({ type: "busy" }),
    })
    expect(resolution).toBe("incomplete")
  })

  test("returns incomplete when the stream ends before idle and the session is retrying", async () => {
    const resolution = await resolveRunCompletion({
      result: { error: undefined, idle: false },
      activeStatus: async () => ({ type: "retry" }),
    })
    expect(resolution).toBe("incomplete")
  })

  // The server deletes idle sessions from the active-status map, so an absent
  // (undefined) lookup means the session actually reached idle: clean finish.
  test("returns idle when the stream ends before idle but the session is absent from the status map", async () => {
    const resolution = await resolveRunCompletion({
      result: { error: undefined, idle: false },
      activeStatus: async () => undefined,
    })
    expect(resolution).toBe("idle")
  })

  test("returns idle when the stream ends before idle but the status lookup reports idle", async () => {
    const resolution = await resolveRunCompletion({
      result: { error: undefined, idle: false },
      activeStatus: async () => ({ type: "idle" }),
    })
    expect(resolution).toBe("idle")
  })

  // A status lookup we cannot complete must not be treated as success.
  test("returns incomplete when the fallback status lookup fails", async () => {
    const resolution = await resolveRunCompletion({
      result: { error: undefined, idle: false },
      activeStatus: async (): Promise<ActiveStatus> => {
        throw new Error("status endpoint unreachable")
      },
    })
    expect(resolution).toBe("incomplete")
  })
})
