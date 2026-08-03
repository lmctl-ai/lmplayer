import { Cause, Deferred, Effect, Exit, Fiber, Latch, Queue, Schema, Scope, Semaphore, SynchronizedRef } from "effect"

export interface Runner<A, E = never> {
  readonly state: State<A, E>
  readonly busy: boolean
  readonly requestRun: {
    (work: Effect.Effect<A, E>, join: true): Effect.Effect<A, E>
    (work: Effect.Effect<A, E>, join: false, priority?: boolean): Effect.Effect<Request<E>>
  }
  readonly ensureRunning: (work: Effect.Effect<A, E>) => Effect.Effect<A, E>
  readonly startShell: (work: Effect.Effect<A, E>, ready?: Latch.Latch) => Effect.Effect<A, E | Busy>
  readonly cancel: Effect.Effect<void>
  readonly dispose: Effect.Effect<void>
}

export type Request<E> =
  | { readonly accepted: false; readonly settled: Effect.Effect<void> }
  | { readonly accepted: true; readonly settled: Effect.Effect<void, E | Cancelled> }

export class Cancelled extends Schema.TaggedErrorClass<Cancelled>()("RunnerCancelled", {}) {}
export class Busy extends Schema.TaggedErrorClass<Busy>()("RunnerBusy", {}) {}

interface RunHandle<A, E> {
  id: number
  done: Deferred.Deferred<A, E | Cancelled>
  fiber: Fiber.Fiber<A, E>
}

interface ShellHandle<A, E> {
  id: number
  cancelled: Deferred.Deferred<void>
  ready?: Latch.Latch
  fiber: Fiber.Fiber<A, E>
}

interface PendingHandle<A, E> {
  id: number
  done: Deferred.Deferred<A, E | Cancelled>
  work: Effect.Effect<A, E>
}

export type State<A, E> =
  | { readonly _tag: "Idle" }
  | {
      readonly _tag: "Running"
      readonly run: RunHandle<A, E>
      readonly pending?: PendingHandle<A, E>
    }
  | { readonly _tag: "Shell"; readonly shell: ShellHandle<A, E> }
  | {
      readonly _tag: "ShellThenRun"
      readonly shell: ShellHandle<A, E>
      readonly run: PendingHandle<A, E>
    }
  | { readonly _tag: "Disposed" }

export const make = <A, E = never>(
  scope: Scope.Scope,
  opts?: {
    onIdle?: Effect.Effect<void>
    onBusy?: Effect.Effect<void>
    onInterrupt?: Effect.Effect<A, E>
  },
): Runner<A, E> => {
  const ref = SynchronizedRef.makeUnsafe<State<A, E>>({ _tag: "Idle" })
  const status = Queue.unbounded<{ value: "idle" | "busy"; done: Deferred.Deferred<void> }>().pipe(Effect.runSync)
  const statusLock = Semaphore.makeUnsafe(1)
  const idle = opts?.onIdle ?? Effect.void
  const onBusy = opts?.onBusy ?? Effect.void
  const onInterrupt = opts?.onInterrupt
  let ids = 0

  const state = () => SynchronizedRef.getUnsafe(ref)
  const next = () => ++ids
  const publish = (value: "idle" | "busy") =>
    Effect.gen(function* () {
      const done = yield* Deferred.make<void>()
      yield* Queue.offer(status, { value, done })
      return done
    })
  const drainStatus = statusLock.withPermit(
    Queue.takeAll(status).pipe(
      Effect.flatMap((events) =>
        Effect.forEach(
          events,
          (event) =>
            (event.value === "idle" ? idle : onBusy).pipe(
              Effect.catchCause((cause) =>
                Effect.logError("runner status publication failed", { event: event.value, cause }),
              ),
              Effect.ensuring(Deferred.succeed(event.done, undefined).pipe(Effect.asVoid)),
            ),
          { discard: true },
        ),
      ),
    ),
  )
  const triggerStatus = drainStatus.pipe(Effect.forkIn(scope), Effect.asVoid)
  const flushStatus = (done: Deferred.Deferred<void>) => drainStatus.pipe(Effect.andThen(Deferred.await(done)))

  const complete = (done: Deferred.Deferred<A, E | Cancelled>, exit: Exit.Exit<A, E>) =>
    Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
      ? Deferred.fail(done, new Cancelled()).pipe(Effect.asVoid)
      : Deferred.done(done, exit).pipe(Effect.asVoid)

  const awaitDone = (done: Deferred.Deferred<A, E | Cancelled>) =>
    Deferred.await(done).pipe(Effect.catchTag("RunnerCancelled", (error) => onInterrupt ?? Effect.die(error)))

  const accepted = (done: Deferred.Deferred<A, E | Cancelled>): Request<E> => ({
    accepted: true,
    settled: Deferred.await(done).pipe(Effect.asVoid),
  })
  const rejected: Request<E> = { accepted: false, settled: Effect.void }

  const startRun: (
    work: Effect.Effect<A, E>,
    done: Deferred.Deferred<A, E | Cancelled>,
  ) => Effect.Effect<RunHandle<A, E>> = (work, done) =>
    Effect.gen(function* () {
      const id = next()
      const fiber = yield* work.pipe(
        Effect.onExit((exit) => finishRun(id, done, exit)),
        Effect.forkIn(scope),
      )
      return { id, done, fiber } satisfies RunHandle<A, E>
    })

  const finishRun: (
    id: number,
    done: Deferred.Deferred<A, E | Cancelled>,
    exit: Exit.Exit<A, E>,
  ) => Effect.Effect<void> = (id, done, exit) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (current) {
        if (current._tag !== "Running" || current.run.id !== id) return [complete(done, exit), current] as const
        if (current.pending) {
          const run = yield* startRun(current.pending.work, current.pending.done)
          return [complete(done, exit), { _tag: "Running", run } as const] as const
        }
        const published = yield* publish("idle")
        return [flushStatus(published).pipe(Effect.andThen(complete(done, exit))), { _tag: "Idle" } as const] as const
      }),
    ).pipe(Effect.uninterruptible, Effect.flatten)

  const finishShell: (id: number) => Effect.Effect<void> = (id) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (current) {
        if (current._tag === "Shell" && current.shell.id === id) {
          const published = yield* publish("idle")
          return [flushStatus(published), { _tag: "Idle" } as const] as const
        }
        if (current._tag === "ShellThenRun" && current.shell.id === id) {
          const run = yield* startRun(current.run.work, current.run.done)
          return [Effect.void, { _tag: "Running", run } as const] as const
        }
        return [Effect.void, current] as const
      }),
    ).pipe(Effect.uninterruptible, Effect.flatten)

  const stopShell = (shell: ShellHandle<A, E>) =>
    Effect.gen(function* () {
      if (shell.ready) yield* shell.ready.await.pipe(Effect.exit, Effect.asVoid)
      yield* Deferred.succeed(shell.cancelled, undefined).pipe(Effect.asVoid)
      yield* Fiber.interrupt(shell.fiber)
    })

  const requestRun = (work: Effect.Effect<A, E>, join: boolean, priority = false): Effect.Effect<A | Request<E>, E> =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (current) {
        if (current._tag === "Disposed") {
          return [join ? Effect.die(new Cancelled()) : Effect.succeed(rejected), current] as const
        }
        if (current._tag === "Running") {
          if (join) return [awaitDone(current.run.done), current] as const
          if (current.pending) {
            const pending = {
              ...current.pending,
              id: next(),
              work: priority
                ? work.pipe(Effect.ensuring(current.pending.work.pipe(Effect.exit, Effect.asVoid)))
                : current.pending.work.pipe(Effect.ensuring(work.pipe(Effect.exit, Effect.asVoid))),
            }
            return [Effect.succeed(accepted(pending.done)), { ...current, pending }] as const
          }
          const pending = { id: next(), done: yield* Deferred.make<A, E | Cancelled>(), work }
          return [Effect.succeed(accepted(pending.done)), { ...current, pending }] as const
        }
        if (current._tag === "ShellThenRun") {
          if (join) return [awaitDone(current.run.done), current] as const
          return [
            Effect.succeed(accepted(current.run.done)),
            {
              ...current,
              run: {
                ...current.run,
                id: next(),
                work: priority
                  ? work.pipe(Effect.ensuring(current.run.work.pipe(Effect.exit, Effect.asVoid)))
                  : current.run.work.pipe(Effect.ensuring(work.pipe(Effect.exit, Effect.asVoid))),
              },
            },
          ] as const
        }
        if (current._tag === "Shell") {
          const run = { id: next(), done: yield* Deferred.make<A, E | Cancelled>(), work }
          return [
            join ? awaitDone(run.done) : Effect.succeed(accepted(run.done)),
            { _tag: "ShellThenRun", shell: current.shell, run } as const,
          ] as const
        }
        const done = yield* Deferred.make<A, E | Cancelled>()
        const run = yield* startRun(work, done)
        const published = yield* publish("busy")
        return [
          join
            ? flushStatus(published).pipe(Effect.andThen(awaitDone(done)))
            : triggerStatus.pipe(Effect.as(accepted(done))),
          { _tag: "Running", run } as const,
        ] as const
      }),
    ).pipe(
      Effect.uninterruptible,
      Effect.flatMap((next) => next as Effect.Effect<A | Request<E>, E>),
    )

  const startShell = (work: Effect.Effect<A, E>, ready?: Latch.Latch): Effect.Effect<A, E | Busy> =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (current) {
        if (current._tag !== "Idle") {
          const reject: Effect.Effect<A, E | Busy> = Effect.fail(new Busy())
          return [reject, current] as const
        }
        const published = yield* publish("busy")
        const id = next()
        const cancelled = yield* Deferred.make<void>()
        const fiber = yield* work.pipe(Effect.ensuring(finishShell(id)), Effect.forkChild)
        const shell = { id, cancelled, ready, fiber } satisfies ShellHandle<A, E>
        return [
          Effect.gen(function* () {
            yield* flushStatus(published)
            const exit = yield* Fiber.await(fiber)
            if (Exit.isSuccess(exit)) return exit.value
            if (
              Cause.hasInterruptsOnly(exit.cause) ||
              ((yield* Deferred.isDone(cancelled)) && Cause.hasInterrupts(exit.cause) && !Cause.hasDies(exit.cause))
            ) {
              if (onInterrupt) return yield* onInterrupt
              return yield* Effect.die(new Cancelled())
            }
            return yield* Effect.failCause(exit.cause)
          }),
          { _tag: "Shell", shell } as const,
        ] as const
      }),
    ).pipe(Effect.uninterruptible, Effect.flatten)

  const cancel = SynchronizedRef.modifyEffect(
    ref,
    Effect.fnUntraced(function* (current) {
      if (current._tag === "Idle" || current._tag === "Disposed") return [Effect.void, current] as const
      const published = yield* publish("idle")
      if (current._tag === "Running") {
        return [
          Effect.gen(function* () {
            yield* flushStatus(published)
            if (current.pending) yield* Deferred.fail(current.pending.done, new Cancelled()).pipe(Effect.asVoid)
            yield* Fiber.interrupt(current.run.fiber)
            yield* Deferred.fail(current.run.done, new Cancelled()).pipe(Effect.asVoid)
          }),
          { _tag: "Idle" } as const,
        ] as const
      }
      return [
        Effect.gen(function* () {
          yield* flushStatus(published)
          yield* stopShell(current.shell)
          if (current._tag === "ShellThenRun")
            yield* Deferred.fail(current.run.done, new Cancelled()).pipe(Effect.asVoid)
        }),
        { _tag: "Idle" } as const,
      ] as const
    }),
  ).pipe(Effect.uninterruptible, Effect.flatten)

  const dispose = SynchronizedRef.modifyEffect(
    ref,
    Effect.fnUntraced(function* (current) {
      if (current._tag === "Disposed") return [Effect.void, current] as const
      if (current._tag === "Idle") return [Effect.void, { _tag: "Disposed" } as const] as const
      const published = yield* publish("idle")
      if (current._tag === "Running") {
        return [
          Effect.gen(function* () {
            yield* flushStatus(published)
            if (current.pending) yield* Deferred.fail(current.pending.done, new Cancelled()).pipe(Effect.asVoid)
            yield* Fiber.interrupt(current.run.fiber)
            yield* Deferred.fail(current.run.done, new Cancelled()).pipe(Effect.asVoid)
          }),
          { _tag: "Disposed" } as const,
        ] as const
      }
      return [
        Effect.gen(function* () {
          yield* flushStatus(published)
          yield* stopShell(current.shell)
          if (current._tag === "ShellThenRun")
            yield* Deferred.fail(current.run.done, new Cancelled()).pipe(Effect.asVoid)
        }),
        { _tag: "Disposed" } as const,
      ] as const
    }),
  ).pipe(Effect.uninterruptible, Effect.flatten)

  return {
    get state() {
      return state()
    },
    get busy() {
      const current = state()
      return current._tag !== "Idle" && current._tag !== "Disposed"
    },
    requestRun: requestRun as Runner<A, E>["requestRun"],
    ensureRunning: (work) => requestRun(work, true) as Effect.Effect<A, E>,
    startShell,
    cancel,
    dispose,
  }
}

export * as Runner from "./runner"
