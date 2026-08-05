import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Runner } from "@/effect/runner"
import { BackgroundJob } from "@/background/job"
import { Effect, Latch, Layer, Scope, Context, SynchronizedRef } from "effect"
import { Session } from "./session"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"

export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
  ) => Effect.Effect<SessionV1.WithParts>
  readonly wake: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
  ) => Effect.Effect<Runner.Request<never>>
  readonly wakeIfIdle: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
  ) => Effect.Effect<Runner.Request<never>>
  readonly admit: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
  ) => Effect.Effect<void>
  readonly dispose: (sessionID: SessionID) => Effect.Effect<void>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
    ready?: Latch.Latch,
  ) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunState") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const status = yield* SessionStatus.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* () {
        const scope = yield* Scope.Scope
        const runners = SynchronizedRef.makeUnsafe(
          new Map<
            SessionID,
            | { type: "live"; generation: number; runner: Runner.Runner<SessionV1.WithParts> }
            | { type: "disposed"; generation: number }
          >(),
        )
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            const active = yield* SynchronizedRef.modify(runners, (entries) => {
              const live = [...entries.values()].filter((entry) => entry.type === "live")
              return [
                live,
                new Map(
                  [...entries].map(([sessionID, entry]) => [
                    sessionID,
                    { type: "disposed" as const, generation: entry.generation + 1 },
                  ]),
                ),
              ] as const
            })
            yield* Effect.forEach(active, (entry) => entry.runner.dispose, {
              concurrency: "unbounded",
              discard: true,
            })
          }),
        )
        return { runners, scope }
      }),
    )

    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
    ) {
      const data = yield* InstanceState.get(state)
      return yield* SynchronizedRef.modifyEffect(
        data.runners,
        Effect.fnUntraced(function* (entries) {
          const existing = entries.get(sessionID)
          if (existing?.type === "disposed") return [undefined, entries] as const
          if (existing) return [existing.runner, entries] as const
          const next = Runner.make<SessionV1.WithParts>(data.scope, {
            onIdle: status.set(sessionID, { type: "idle" }),
            onBusy: status.set(sessionID, { type: "busy" }),
            onInterrupt,
          })
          const updated = new Map(entries)
          updated.set(sessionID, { type: "live", generation: 1, runner: next })
          return [next, updated] as const
        }),
      )
    })

    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = (yield* SynchronizedRef.get(data.runners)).get(sessionID)
      if (existing?.type === "live" && existing.runner.busy) yield* busyError(sessionID)
    })

    const cancel = Effect.fn("SessionRunState.cancel")(function* (sessionID: SessionID) {
      yield* cancelBackgroundJobs(background, sessionID)
      const data = yield* InstanceState.get(state)
      const existing = (yield* SynchronizedRef.get(data.runners)).get(sessionID)
      if (!existing || existing.type === "disposed") return
      yield* existing.runner.cancel
    })

    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
    ) {
      const current = yield* runner(sessionID, onInterrupt)
      if (!current) return yield* onInterrupt
      return yield* current.ensureRunning(work)
    })

    const wake = Effect.fn("SessionRunState.wake")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
    ) {
      const current = yield* runner(sessionID, onInterrupt)
      if (!current) return { accepted: false as const, settled: Effect.void }
      return yield* current.requestRun(work, false)
    })

    const wakeIfIdle = Effect.fn("SessionRunState.wakeIfIdle")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
    ) {
      const current = yield* runner(sessionID, onInterrupt)
      if (!current) return { accepted: false as const, settled: Effect.void }
      return yield* current.requestRunIfIdle(work)
    })

    const admit = Effect.fn("SessionRunState.admit")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
    ) {
      const current = yield* runner(sessionID, onInterrupt)
      if (!current) return
      yield* current.requestRun(work, false, true)
    })

    const dispose = Effect.fn("SessionRunState.dispose")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const current = yield* SynchronizedRef.modify(data.runners, (entries) => {
        const existing = entries.get(sessionID)
        if (existing?.type === "disposed") return [undefined, entries] as const
        const generation = (existing?.generation ?? 0) + 1
        const updated = new Map(entries)
        updated.set(sessionID, { type: "disposed", generation })
        return [existing?.type === "live" ? existing.runner : undefined, updated] as const
      })
      if (current) yield* current.dispose
    })

    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
      ready?: Latch.Latch,
    ) {
      const current = yield* runner(sessionID, onInterrupt)
      if (!current) return yield* Effect.fail(busyError(sessionID))
      return yield* current
        .startShell(work, ready)
        .pipe(Effect.catchTag("RunnerBusy", () => Effect.fail(busyError(sessionID))))
    })

    return Service.of({
      assertNotBusy,
      cancel,
      ensureRunning,
      wake,
      wakeIfIdle,
      admit,
      dispose,
      startShell,
    })
  }),
)

const cancelBackgroundJobs = Effect.fn("SessionRunState.cancelBackgroundJobs")(function* (
  background: BackgroundJob.Interface,
  sessionID: SessionID,
) {
  const jobs = yield* background.list()
  const pending = new Set<string>([sessionID])
  const cancelled = new Set<string>()
  const matches = (job: BackgroundJob.Info) => {
    if (job.status !== "running") return false
    if (cancelled.has(job.id)) return false
    if (pending.has(job.id)) return true
    if (typeof job.metadata?.sessionId === "string" && pending.has(job.metadata.sessionId)) return true
    return typeof job.metadata?.parentSessionId === "string" && pending.has(job.metadata.parentSessionId)
  }
  let batch = jobs.filter(matches)
  while (batch.length > 0) {
    yield* Effect.forEach(
      batch,
      (job) =>
        background.cancel(job.id).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              cancelled.add(job.id)
              pending.add(job.id)
              if (typeof job.metadata?.sessionId === "string") pending.add(job.metadata.sessionId)
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    )
    batch = jobs.filter(matches)
  }
})

function busyError(sessionID: SessionID) {
  return new Session.BusyError({ sessionID })
}

export const node = LayerNode.make({ service: Service, layer: layer, deps: [BackgroundJob.node, SessionStatus.node] })

export * as SessionRunState from "./run-state"
