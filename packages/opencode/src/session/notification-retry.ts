import { Cause, Context, Deferred, Effect, Exit, Scope, Semaphore } from "effect"

export const Policy = Context.Reference<{
  readonly maxAttempts?: number
  readonly delay?: (attempt: number) => Effect.Effect<void>
}>("@opencode/SessionJobNotificationRetry/Policy", {
  defaultValue: () => ({}),
})

export interface Owner<Key> {
  readonly schedule: (key: Key) => Effect.Effect<void>
  readonly recover: (key: Key) => Effect.Effect<void>
  readonly wait: (key: Key) => Effect.Effect<void>
  readonly isDegraded: (key: Key) => boolean
}

export const make = <Key>(input: {
  readonly attempt: (key: Key) => Effect.Effect<boolean, unknown>
  readonly maxAttempts?: number
  readonly delay?: (attempt: number) => Effect.Effect<void>
  readonly onDegraded?: (key: Key, attempts: number, cause: Cause.Cause<unknown>) => Effect.Effect<void>
  readonly onRecovered?: (key: Key) => Effect.Effect<void>
  readonly onOwnerCreated?: (key: Key) => Effect.Effect<void>
}) =>
  Effect.gen(function* () {
    const policy = yield* Policy
    const scope = yield* Scope.Scope
    const entries = new Map<
      Key,
      { token: string; requested: boolean; recoverRequested: boolean; done: Deferred.Deferred<void> }
    >()
    const degraded = new Set<Key>()
    const lock = Semaphore.makeUnsafe(1)
    const maxAttempts = input.maxAttempts ?? policy.maxAttempts ?? 6
    const delay =
      input.delay ??
      policy.delay ??
      ((attempt: number) => Effect.sleep(`${Math.min(30_000, 250 * 2 ** (attempt - 1))} millis`))

    const run: (key: Key, token: string, attempt?: number) => Effect.Effect<void> = Effect.fn(
      "SessionJobNotificationRetry.run",
    )(function* (key, token, attempt = 0) {
      const active = entries.get(key)
      if (active?.token !== token) return
      active.requested = false
      const result = yield* input.attempt(key).pipe(Effect.exit)
      if (Exit.isSuccess(result)) {
        const recovered = degraded.delete(key) ? input.onRecovered?.(key) : undefined
        if (recovered) yield* recovered
        if (result.value || entries.get(key)?.requested) return yield* run(key, token)
        return
      }
      const next = attempt + 1
      if (next >= maxAttempts) {
        active.requested = false
        degraded.add(key)
        const onDegraded = input.onDegraded?.(key, next, result.cause)
        if (onDegraded) yield* onDegraded
        return
      }
      yield* delay(next)
      return yield* run(key, token, next)
    })

    const enqueue: (key: Key, recover: boolean) => Effect.Effect<void> = (key, recover) =>
      lock.withPermit(
        Effect.gen(function* () {
          const current = entries.get(key)
          if (current) {
            if (recover && degraded.has(key)) current.recoverRequested = true
            else current.requested = true
            return
          }
          const token = crypto.randomUUID()
          const done = yield* Deferred.make<void>()
          entries.set(key, { token, requested: false, recoverRequested: false, done })
          const onOwnerCreated = input.onOwnerCreated?.(key)
          if (onOwnerCreated) yield* onOwnerCreated
          yield* run(key, token).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                const active = entries.get(key)
                if (active?.token !== token) return
                entries.delete(key)
                yield* Deferred.succeed(done, undefined).pipe(Effect.asVoid)
                if (active.recoverRequested || (active.requested && !degraded.has(key))) yield* enqueue(key, false)
              }),
            ),
            Effect.forkIn(scope),
          )
        }).pipe(Effect.uninterruptible, Effect.asVoid),
      )

    const schedule: Owner<Key>["schedule"] = (key) => enqueue(key, false)

    return {
      schedule,
      recover: (key) => enqueue(key, true),
      wait: (key) => {
        const current = entries.get(key)
        return current ? Deferred.await(current.done) : Effect.void
      },
      isDegraded: (key) => degraded.has(key),
    } satisfies Owner<Key>
  })

export * as SessionJobNotificationRetry from "./notification-retry"
