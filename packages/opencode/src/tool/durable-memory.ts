import { Effect, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionDurableMemory } from "@/session/durable-memory"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["read", "write", "append"]).annotate({
    description:
      "Operation to perform on durable memory: 'read' to view current memory, 'write' to replace/set entire memory, 'append' to add a note or section to the end of durable memory",
  }),
  content: Schema.optional(Schema.String).annotate({
    description: "Markdown content to store in durable memory (required for 'write' and 'append')",
  }),
  sessionID: Schema.optional(Schema.String).annotate({
    description: "Target session ID. Defaults to the current session.",
  }),
})

type Metadata = {
  action: "read" | "write" | "append"
  bytes: number
  sessionID: string
}

const DESCRIPTION = `Read or update the persistent durable memory (durable-memory/index.md) for this session.

Durable memory survives across turns and is injected into your system prompt on every turn as authoritative context.

Use action='read' to view the current session's durable memory.
Use action='write' with content to replace or initialize the durable memory (recommended when organizing, updating sections, or dropping stale facts).
Use action='append' with content to add a new note or section to the end of existing durable memory.

Structure recommendations: Keep content terse with Markdown bullet points. Use standard sections such as:
## Goal
## Constraints & Preferences
## Key Decisions
## Current State
## Open Threads / Next Steps
## Critical Context
## Relevant Files & Commands`

export const DurableMemoryTool = Tool.define<typeof Parameters, Metadata, FSUtil.Service>(
  "durable_memory",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const read = (sessionID: string) =>
      SessionDurableMemory.read(sessionID).pipe(Effect.provideService(FSUtil.Service, fs))
    const write = (sessionID: string, content: string) =>
      SessionDurableMemory.write(sessionID, content).pipe(Effect.provideService(FSUtil.Service, fs))

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const targetSessionID = params.sessionID?.trim() || ctx.sessionID

          if (params.action === "read") {
            const memory = yield* read(targetSessionID)
            if (!memory || !memory.trim()) {
              return {
                title: `durable-memory (empty)`,
                metadata: { action: "read", bytes: 0, sessionID: targetSessionID } satisfies Metadata,
                output: `(no durable memory recorded yet for session ${targetSessionID})`,
              }
            }
            return {
              title: `durable-memory`,
              metadata: { action: "read", bytes: memory.length, sessionID: targetSessionID } satisfies Metadata,
              output: memory,
            }
          }

          if (!params.content || !params.content.trim()) {
            return yield* new Tool.InvalidArgumentsError({
              tool: "durable_memory",
              detail: `content is required for action '${params.action}' and cannot be empty`,
            })
          }

          yield* ctx.ask({
            permission: "durable_memory",
            patterns: [params.action],
            always: ["*"],
            metadata: { action: params.action, sessionID: targetSessionID },
          })

          const inputContent = params.content.trim()

          if (params.action === "write") {
            yield* write(targetSessionID, inputContent)
            return {
              title: `durable-memory (updated)`,
              metadata: { action: "write", bytes: inputContent.length, sessionID: targetSessionID } satisfies Metadata,
              output: `Updated durable memory for session ${targetSessionID} (${inputContent.length} bytes)`,
            }
          }

          // params.action === "append"
          const prior = yield* read(targetSessionID)
          const merged = prior && prior.trim() ? `${prior.trim()}\n\n${inputContent}` : inputContent
          yield* write(targetSessionID, merged)
          return {
            title: `durable-memory (appended)`,
            metadata: { action: "append", bytes: merged.length, sessionID: targetSessionID } satisfies Metadata,
            output: `Appended to durable memory for session ${targetSessionID} (${merged.length} bytes total)`,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
