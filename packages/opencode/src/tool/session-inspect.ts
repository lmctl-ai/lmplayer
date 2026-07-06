import { Effect, Schema } from "effect"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { NotFoundError } from "@/storage/storage"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  mode: Schema.Literals(["list", "tail"]).annotate({
    description: "Operation mode: 'list' to enumerate sessions, 'tail' to view recent messages in a session",
  }),
  sessionID: Schema.optional(Schema.String).annotate({
    description: "Session ID to inspect (required when mode is 'tail')",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum number of items to return. Defaults to 10.",
  }),
})

type Metadata = {
  mode: string
  count: number
}

const DESCRIPTION = `Inspect sessions for the current project.

Use mode=list to enumerate sessions (compact one-liner per session: id, title, updated-age).
Use mode=tail with a sessionID to view the last N messages in that session.

Useful for lead agents auditing ongoing work or verifying context of a child session.`

export const SessionInspectTool = Tool.define<typeof Parameters, Metadata, Session.Service>(
  "session_inspect",
  Effect.gen(function* () {
    const session = yield* Session.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : 10

          if (params.mode === "list") {
            const sessions = yield* session.list({ limit })
            const now = Date.now()
            const lines = sessions.map((s) => {
              const ageMins = Math.round((now - s.time.updated) / 60_000)
              const age = ageMins < 60 ? `${ageMins}m` : `${Math.round(ageMins / 60)}h`
              return `${s.id}  ${s.title}  (${age} ago)`
            })
            return {
              title: "sessions",
              metadata: { mode: "list", count: sessions.length } satisfies Metadata,
              output: lines.length > 0 ? lines.join("\n") : "(no sessions)",
            }
          }

          if (!params.sessionID) {
            return {
              title: "error",
              metadata: { mode: "tail", count: 0 } satisfies Metadata,
              output: "sessionID is required for tail mode",
            }
          }

          const sid = SessionID.make(params.sessionID)
          const messages = yield* session
            .messages({ sessionID: sid, limit })
            .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(null as SessionV1.WithParts[] | null)))

          if (!messages) {
            return {
              title: `session:${params.sessionID}`,
              metadata: { mode: "tail", count: 0 } satisfies Metadata,
              output: `Session not found: ${params.sessionID}`,
            }
          }

          const lines = messages.map((msg) => {
            const text = msg.parts
              .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : []))
              .join("")
              .trim()
              .slice(0, 200)
            if (text) return `${msg.info.role}: ${text}`
            const tools = msg.parts.flatMap((part) =>
              part.type === "tool" ? [`[${part.tool}:${part.state.status}]`] : [],
            )
            if (tools.length > 0) return `${msg.info.role}: ${tools.join(" ")}`
            return `${msg.info.role}: (empty)`
          })

          return {
            title: `session:${params.sessionID}`,
            metadata: { mode: "tail", count: messages.length } satisfies Metadata,
            output: lines.length > 0 ? lines.join("\n") : "(no messages)",
          }
        }).pipe(Effect.orDie),
    }
  }),
)
