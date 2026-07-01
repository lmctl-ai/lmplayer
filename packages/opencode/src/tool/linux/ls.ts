import path from "path"
import { Effect, Schema } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { InstanceState } from "@/effect/instance-state"
import { Tool } from "../tool"
import { assertExternalDirectoryEffect } from "../external-directory"
import { exec, report } from "./exec"

export const Parameters = Schema.Struct({
  path: Schema.optional(Schema.String).annotate({
    description: "The directory to list (absolute, or relative to the project). Defaults to '.'",
  }),
  all: Schema.optional(Schema.Boolean).annotate({ description: "Include hidden entries (ls -a)" }),
  long: Schema.optional(Schema.Boolean).annotate({ description: "Use long listing format (ls -l)" }),
})

export const LsTool = Tool.define(
  "ls",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    return {
      description: "List directory contents. Wraps `ls` with structured, typed parameters.",
      parameters: Parameters,
      execute: (params: { path?: string; all?: boolean; long?: boolean }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const target = params.path ?? "."
          const absPath = path.isAbsolute(target) ? target : path.resolve(instance.directory, target)
          const rel = path.relative(instance.worktree, absPath)

          yield* assertExternalDirectoryEffect(ctx, absPath, { kind: "directory" })
          yield* ctx.ask({
            permission: "read",
            patterns: [rel],
            always: [],
            metadata: { path: absPath, all: params.all ?? false, long: params.long ?? false },
          })

          const args = [...(params.all ? ["-a"] : []), ...(params.long ? ["-l"] : []), "--", absPath]
          const result = yield* exec(spawner, "ls", args, instance.directory)
          return report({
            binary: "ls",
            result,
            title: rel,
            success: `Listed ${absPath}`,
          })
        }).pipe(Effect.orDie),
    }
  }),
)
