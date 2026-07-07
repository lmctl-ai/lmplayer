// Resident outbound poll loop. Injects remote-operator instructions into the
// current session through the SAME admission path as a user prompt typed in
// the TUI: `submit` is dependency-injected over the real
// `client.session.prompt(...)` SDK call (see `cli/cmd/run.ts`). This module
// never appends messages directly and never bypasses that admission path.
import { Duration, Effect, Ref, Result, Schedule } from "effect"
import { errorMessage } from "@/util/error"
import type { Channel, Detail } from "./channel"

export interface SubmitReply {
  readonly parts: ReadonlyArray<{ readonly type: string; readonly text?: string }>
}

// Dependency injection over `client.session.prompt(...)`. Production wires
// this to the real SDK client; tests wire it to a real in-process session
// (never a hand-rolled echo).
export type Submit = (text: string) => Effect.Effect<SubmitReply, unknown>

// Prototype heuristic: "summary" truncates to 280 chars. "delta" is a
// placeholder for future streaming deltas — for this sync prototype it is
// identical to "full".
export const formatReply = (reply: SubmitReply, detail: Detail): string => {
  const full = reply.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("")
  if (detail === "summary") return full.length > 280 ? full.slice(0, 280) + "…" : full
  return full
}

// One deterministic pass: poll once, process each instruction sequentially
// (in `seq` order, awaiting each reply before the next — matches "processed
// in turn"), respond, and advance the `after` cursor. Returns the number of
// instructions processed.
//
// Instructions are processed independently: a failing `submit` (session turn
// error) is converted into a best-effort "ERROR: ..." response instead of
// aborting the pass, and the cursor is ALWAYS advanced past a processed
// instruction (success or handled error) so a single poison instruction
// cannot wedge the loop or block later instructions in the same batch. Only
// a `channel.respond` failure (a channel-level error, not a turn error) is
// allowed to propagate — the caller (`run`) logs and continues on the next
// interval.
export const drainOnce = <R>(opts: { channel: Channel<R>; submit: Submit; detail: Detail; after: Ref.Ref<number> }) =>
  Effect.gen(function* () {
    const cursor = yield* Ref.get(opts.after)
    const instructions = yield* opts.channel.poll(cursor)
    const ordered = [...instructions].sort((a, b) => a.seq - b.seq)

    for (const instruction of ordered) {
      const outcome = yield* Effect.result(opts.submit(instruction.text))
      const text = Result.isSuccess(outcome)
        ? formatReply(outcome.success, opts.detail)
        : `ERROR: ${errorMessage(outcome.failure)}`
      yield* opts.channel.respond(instruction.id, { detail: opts.detail, text })
      yield* Ref.update(opts.after, (prev) => Math.max(prev, instruction.seq))
    }

    return ordered.length
  }).pipe(Effect.withSpan("RemotePoller.drainOnce"))

// Resident loop: repeat `drainOnce` on a fixed interval, forked into the
// enclosing scope so it stops when the scope closes (i.e. when the process
// exits — one session = one poller). Poll/HTTP errors are logged and do not
// crash the resident loop.
export const run = <R>(opts: { channel: Channel<R>; submit: Submit; detail: Detail; interval: Duration.Input }) =>
  Effect.gen(function* () {
    const after = Ref.makeUnsafe(0)

    yield* drainOnce({ channel: opts.channel, submit: opts.submit, detail: opts.detail, after }).pipe(
      Effect.catchCause((cause) => Effect.logError("remote poll pass failed", { cause })),
      Effect.repeat(Schedule.spaced(opts.interval)),
      Effect.forkScoped,
    )
  }).pipe(Effect.withSpan("RemotePoller.run"))

export * as RemotePoller from "./poller"
