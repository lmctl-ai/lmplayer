import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Clock, Context, Effect, Layer, Scope, Semaphore } from "effect"
import type { SessionID } from "./schema"

const TICK_INTERVAL = 30_000
export const RECURRING_LIFETIME = 7 * 24 * 60 * 60 * 1000
export const MAX_CRON_JOBS_PER_SESSION = 16

export type Info = {
  readonly id: string
  readonly sessionID: SessionID
  readonly cron: string
  readonly prompt: string
  readonly recurring: boolean
  readonly createdAt: number
  readonly expiresAt?: number
  readonly lastFiredAt?: number
}

type Field = {
  readonly values: ReadonlySet<number>
  readonly wildcard: boolean
}

type Schedule = {
  readonly minute: Field
  readonly hour: Field
  readonly dayOfMonth: Field
  readonly month: Field
  readonly dayOfWeek: Field
}

type Entry = Info & {
  readonly schedule: Schedule
  readonly lastFiredMinute?: number
  readonly firingMinute?: number
}

export class InvalidExpression extends Error {
  readonly _tag = "SessionCronInvalidExpression"

  constructor(
    readonly expression: string,
    readonly detail: string,
  ) {
    super(`Invalid cron expression "${expression}": ${detail}`)
  }
}

export class NotFound extends Error {
  readonly _tag = "SessionCronNotFound"

  constructor(readonly id: string) {
    super(`Cron job not found: ${id}`)
  }
}

export class LimitExceeded extends Error {
  readonly _tag = "SessionCronLimitExceeded"

  constructor(readonly limit: number) {
    super(`A session may have at most ${limit} active cron jobs`)
  }
}

export interface Interface {
  readonly create: (
    sessionID: SessionID,
    input: { cron: string; prompt: string; recurring?: boolean },
  ) => Effect.Effect<Info, InvalidExpression | LimitExceeded>
  readonly list: (sessionID: SessionID) => Effect.Effect<Info[]>
  readonly remove: (sessionID: SessionID, id: string) => Effect.Effect<Info, NotFound>
  readonly removeSession: (sessionID: SessionID) => Effect.Effect<void>
  readonly setWake: (callback: (sessionID: SessionID, prompt: string) => Effect.Effect<boolean>) => Effect.Effect<void>
  readonly tick: (now?: number) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCronRuntime") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const clock = yield* Clock.Clock
    const scope = yield* Scope.Scope
    const lock = Semaphore.makeUnsafe(1)
    const entries = new Map<string, Entry>()
    let wake: ((sessionID: SessionID, prompt: string) => Effect.Effect<boolean>) | undefined

    const create: Interface["create"] = Effect.fn("SessionCronRuntime.create")(function* (sessionID, input) {
      const schedule = yield* Effect.try({
        try: () => parseCron(input.cron),
        catch: (error) => new InvalidExpression(input.cron, error instanceof Error ? error.message : String(error)),
      })
      if (input.prompt.trim().length === 0) {
        return yield* Effect.fail(new InvalidExpression(input.cron, "prompt must not be empty"))
      }
      const createdAt = yield* clock.currentTimeMillis
      const recurring = input.recurring ?? true
      const entry: Entry = {
        id: `cron_${crypto.randomUUID().replaceAll("-", "")}`,
        sessionID,
        cron: input.cron,
        prompt: input.prompt,
        recurring,
        createdAt,
        ...(recurring ? { expiresAt: createdAt + RECURRING_LIFETIME } : {}),
        schedule,
      }
      return yield* lock.withPermit(
        Effect.gen(function* () {
          const count = [...entries.values()].filter((item) => item.sessionID === sessionID).length
          if (count >= MAX_CRON_JOBS_PER_SESSION) {
            return yield* Effect.fail(new LimitExceeded(MAX_CRON_JOBS_PER_SESSION))
          }
          entries.set(entry.id, entry)
          return toInfo(entry)
        }),
      )
    })

    const list: Interface["list"] = Effect.fn("SessionCronRuntime.list")((sessionID) =>
      lock.withPermit(
        Effect.sync(() =>
          [...entries.values()]
            .filter((entry) => entry.sessionID === sessionID)
            .toSorted((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
            .map(toInfo),
        ),
      ),
    )

    const remove: Interface["remove"] = Effect.fn("SessionCronRuntime.remove")(function* (sessionID, id) {
      return yield* lock.withPermit(
        Effect.gen(function* () {
          const entry = entries.get(id)
          if (!entry || entry.sessionID !== sessionID) return yield* Effect.fail(new NotFound(id))
          entries.delete(id)
          return toInfo(entry)
        }),
      )
    })

    const removeSession: Interface["removeSession"] = Effect.fn("SessionCronRuntime.removeSession")((sessionID) =>
      lock.withPermit(
        Effect.sync(() => {
          for (const entry of entries.values()) {
            if (entry.sessionID === sessionID) entries.delete(entry.id)
          }
        }),
      ),
    )

    const tick: Interface["tick"] = Effect.fn("SessionCronRuntime.tick")(function* (inputNow) {
      const now = inputNow ?? (yield* clock.currentTimeMillis)
      const minute = Math.floor(now / 60_000)
      const callback = wake
      const due = yield* lock.withPermit(
        Effect.sync(() => {
          for (const entry of entries.values()) {
            if (entry.recurring && entry.expiresAt !== undefined && now >= entry.expiresAt) {
              entries.delete(entry.id)
            }
          }
          if (!callback) return []
          return [...entries.values()]
            .filter(
              (entry) =>
                entry.firingMinute === undefined &&
                entry.lastFiredMinute !== minute &&
                matches(entry.schedule, new Date(now)),
            )
            .map((entry) => {
              const claimed = { ...entry, firingMinute: minute }
              entries.set(entry.id, claimed)
              return claimed
            })
        }),
      )
      if (!callback) return
      yield* Effect.forEach(
        due,
        (entry) =>
          callback(entry.sessionID, entry.prompt).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("session cron wake failed", {
                sessionID: entry.sessionID,
                cronID: entry.id,
                cause,
              }).pipe(Effect.as(false)),
            ),
            Effect.flatMap((accepted) =>
              lock.withPermit(
                Effect.sync(() => {
                  const current = entries.get(entry.id)
                  if (!current || current.firingMinute !== minute) return
                  if (!accepted) {
                    entries.set(entry.id, { ...current, firingMinute: undefined })
                    return
                  }
                  if (!current.recurring) {
                    entries.delete(entry.id)
                    return
                  }
                  entries.set(entry.id, {
                    ...current,
                    firingMinute: undefined,
                    lastFiredMinute: minute,
                    lastFiredAt: now,
                  })
                }),
              ),
            ),
          ),
        { discard: true },
      )
    })

    const setWake: Interface["setWake"] = (callback) =>
      lock.withPermit(
        Effect.sync(() => {
          wake = callback
        }),
      )

    yield* Effect.forever(Effect.sleep(TICK_INTERVAL).pipe(Effect.andThen(tick()))).pipe(Effect.forkIn(scope))
    yield* Effect.addFinalizer(() =>
      lock.withPermit(
        Effect.sync(() => {
          entries.clear()
          wake = undefined
        }),
      ),
    )

    return Service.of({ create, list, remove, removeSession, setWake, tick })
  }),
)

export function matchesCron(expression: string, date: Date) {
  return matches(parseCron(expression), date)
}

function parseCron(expression: string): Schedule {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error("expected five fields: minute hour day-of-month month day-of-week")
  return {
    minute: parseField(fields[0]!, 0, 59),
    hour: parseField(fields[1]!, 0, 23),
    dayOfMonth: parseField(fields[2]!, 1, 31),
    month: parseField(fields[3]!, 1, 12),
    dayOfWeek: parseField(fields[4]!, 0, 7, (value) => (value === 7 ? 0 : value)),
  }
}

function parseField(input: string, min: number, max: number, normalize = (value: number) => value): Field {
  if (input.length === 0) throw new Error("empty field")
  const values = new Set<number>()
  for (const segment of input.split(",")) {
    if (segment.length === 0) throw new Error(`invalid list in "${input}"`)
    const stepParts = segment.split("/")
    if (stepParts.length > 2) throw new Error(`invalid step in "${segment}"`)
    const base = stepParts[0]!
    const step = stepParts[1] === undefined ? 1 : integer(stepParts[1], 1, max - min + 1, segment)
    const range = base.split("-")
    if (range.length > 2) throw new Error(`invalid range in "${segment}"`)
    const start = base === "*" ? min : integer(range[0]!, min, max, segment)
    const end =
      base === "*" ? max : range[1] !== undefined ? integer(range[1], min, max, segment) : stepParts[1] ? max : start
    if (start > end) throw new Error(`range starts after it ends in "${segment}"`)
    for (let value = start; value <= end; value += step) values.add(normalize(value))
  }
  return { values, wildcard: input.split(",").some((segment) => segment.split("/")[0] === "*") }
}

function integer(input: string, min: number, max: number, segment: string) {
  if (!/^\d+$/.test(input)) throw new Error(`expected an integer in "${segment}"`)
  const value = Number(input)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`value ${input} is outside ${min}-${max}`)
  }
  return value
}

function matches(schedule: Schedule, date: Date) {
  if (!schedule.minute.values.has(date.getMinutes())) return false
  if (!schedule.hour.values.has(date.getHours())) return false
  if (!schedule.month.values.has(date.getMonth() + 1)) return false
  const dayOfMonth = schedule.dayOfMonth.values.has(date.getDate())
  const dayOfWeek = schedule.dayOfWeek.values.has(date.getDay())
  if (schedule.dayOfMonth.wildcard) return dayOfWeek
  if (schedule.dayOfWeek.wildcard) return dayOfMonth
  return dayOfMonth || dayOfWeek
}

function toInfo(entry: Entry): Info {
  return {
    id: entry.id,
    sessionID: entry.sessionID,
    cron: entry.cron,
    prompt: entry.prompt,
    recurring: entry.recurring,
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
    lastFiredAt: entry.lastFiredAt,
  }
}

export const node = LayerNode.make({ service: Service, layer, deps: [] })

export * as SessionCronRuntime from "./cron-runtime"
