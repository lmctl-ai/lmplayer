// Terminal-state resolution for a non-interactive `run`.
//
// A non-interactive run consumes the session event stream until it observes a
// terminal `session.status: idle` (clean finish) or a `session.error` (failed
// turn). The stream can also END before either signal arrives — e.g. the server
// closes the subscription or the connection drops mid-turn. Returning cleanly in
// that case is a FALSE SUCCESS: exit 0 with empty output on a turn that never
// reached a terminal state (root cause reported by lmctl / lmplayerdev seq30).
//
// `resolveRunCompletion` closes that gap. When the stream ended without a
// terminal signal, it consults a direct session-status lookup. Only a session
// that is genuinely idle counts as a clean finish; a still-active session — or a
// status lookup we cannot confirm — is reported as "incomplete" so the caller
// exits nonzero instead of reporting success it never observed.

// The only part of a session status we need is its discriminant. The server
// deletes idle sessions from the active-status map, so an `undefined` lookup
// means idle / no active run (see src/session/status.ts).
export type ActiveStatus = { type: string } | undefined

export type RunStreamResult = {
  // Any session error text surfaced while consuming the stream. Set means the
  // turn already reached a terminal error state.
  error: string | undefined
  // Whether a terminal `session.status: idle` was actually observed, as opposed
  // to the stream simply ending before any terminal signal.
  idle: boolean
}

export type RunCompletion = "idle" | "error" | "incomplete"

export async function resolveRunCompletion(input: {
  result: RunStreamResult
  activeStatus: () => Promise<ActiveStatus>
}): Promise<RunCompletion> {
  if (input.result.error) return "error"
  if (input.result.idle) return "idle"

  // The stream ended before a terminal signal. Confirm the session actually
  // reached idle; a failed lookup is treated as still-active because success we
  // cannot verify must not be reported as success.
  const active = await input.activeStatus().catch(() => ({ type: "busy" }) as ActiveStatus)
  if (active && active.type !== "idle") return "incomplete"
  return "idle"
}
