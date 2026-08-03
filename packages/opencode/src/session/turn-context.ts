import { Context, Effect } from "effect"
import type { SessionID } from "./schema"

export interface Info {
  readonly sessionID?: SessionID
  readonly notificationOrigin: boolean
}

export const Current = Context.Reference<Info>("@opencode/SessionTurnContext", {
  defaultValue: () => ({ notificationOrigin: false }),
})

export function provide<A, E, R>(effect: Effect.Effect<A, E, R>, info: Info) {
  return effect.pipe(Effect.provideService(Current, info))
}

export * as SessionTurnContext from "./turn-context"
