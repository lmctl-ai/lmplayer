import { Effect, Schema } from "effect"
import { SessionCronRuntime } from "@/session/cron-runtime"
import * as Tool from "./tool"

// Keep the action schema flat for providers that reject a top-level union in a tool schema.
// Runtime validation below enforces the fields required by create and delete.
export const Parameters = Schema.Struct({
  action: Schema.Literals(["create", "list", "delete"]).annotate({
    description: "Operation to perform on this session's in-memory cron jobs",
  }),
  cron: Schema.optional(
    Schema.String.annotate({ description: "Standard five-field cron expression evaluated in local time" }),
  ),
  prompt: Schema.optional(Schema.String.annotate({ description: "Prompt to run each time the schedule fires" })),
  recurring: Schema.optional(
    Schema.Boolean.annotate({ description: "Whether to recur; defaults to true", default: true }),
  ),
  id: Schema.optional(Schema.String.annotate({ description: "Cron job ID returned by create" })),
})

export const CronTool = Tool.define(
  "cron",
  Effect.gen(function* () {
    const runtime = yield* SessionCronRuntime.Service
    return {
      description:
        "Manage in-memory cron jobs for this session. Create a job from a standard five-field local-time cron expression and a prompt, list this session's jobs, or delete one. Recurring jobs expire after seven days; jobs disappear when this opencode process exits.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx) =>
        Effect.gen(function* () {
          if (params.action === "list") return result("Session cron jobs", yield* runtime.list(ctx.sessionID))
          if (params.action === "delete") {
            const id = yield* required("id", params.id)
            const removed = yield* runtime
              .remove(ctx.sessionID, id)
              .pipe(Effect.mapError((error) => new Tool.InvalidArgumentsError({ tool: "cron", detail: error.message })))
            return result(`Deleted ${id}`, removed)
          }
          const cron = yield* required("cron", params.cron)
          const prompt = yield* required("prompt", params.prompt)
          // Mirror job.ts's `stop` ask: scheduling a future self-prompt is a
          // standing action on the session (like stopping a background job),
          // so it should be governed by file-based permission rules too, not
          // created unconditionally.
          yield* ctx.ask({
            permission: "cron",
            patterns: ["create"],
            always: [],
            metadata: { cron, prompt },
          })
          const created = yield* runtime
            .create(ctx.sessionID, { cron, prompt, recurring: params.recurring })
            .pipe(Effect.mapError((error) => new Tool.InvalidArgumentsError({ tool: "cron", detail: error.message })))
          return result(created.id, created)
        }).pipe(Effect.orDie),
    }
  }),
)

const required = Effect.fn("CronTool.required")(function* (field: string, value: string | undefined) {
  if (value !== undefined && value.length > 0) return value
  return yield* Effect.fail(
    new Tool.InvalidArgumentsError({ tool: "cron", detail: `${field} is required for this action` }),
  )
})

function result(title: string, value: unknown) {
  return { title, metadata: {}, output: JSON.stringify(value) }
}
