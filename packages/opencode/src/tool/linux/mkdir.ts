import path from "path"
import { Effect, Schema } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { InstanceState } from "@/effect/instance-state"
import { Tool } from "../tool"
import { assertExternalDirectoryEffect } from "../external-directory"
import { exec, report } from "./exec"

export const Parameters = Schema.Struct({
  path: Schema.String.annotate({ description: "The directory path to create (absolute, or relative to the project)" }),
  parents: Schema.optional(Schema.Boolean).annotate({
    description: "Create parent directories as needed and succeed if it exists (mkdir -p). Defaults to true.",
  }),
})

// Structured `mkdir`. Future semantic permission verb: create.
export const MkdirTool = Tool.define(
  "mkdir",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    return {
      description: "Create a directory. Wraps `mkdir` with structured, typed parameters.",
      parameters: Parameters,
      execute: (params: { path: string; parents?: boolean }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const abs = path.isAbsolute(params.path) ? params.path : path.resolve(instance.directory, params.path)
          const parents = params.parents ?? true

          // Gate paths outside the worktree behind the dedicated external_directory
          // permission, then the normal edit ask (mirrors write.ts/edit.ts ordering).
          yield* assertExternalDirectoryEffect(ctx, abs, { kind: "directory" })
          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(instance.worktree, abs)],
            always: [],
            metadata: { path: abs, parents },
          })

          // `--` terminates option parsing so a path beginning with `-` is never
          // misparsed as a flag (flag-injection guard).
          const args = [...(parents ? ["-p"] : []), "--", abs]
          const result = yield* exec(spawner, "mkdir", args, instance.directory)
          return report({
            binary: "mkdir",
            result,
            title: path.relative(instance.worktree, abs),
            success: `Created directory ${abs}`,
          })
        }).pipe(Effect.orDie),
    }
  }),
)
