import path from "path"
import { Effect, Schema } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { InstanceState } from "@/effect/instance-state"
import { Tool } from "../tool"
import { assertExternalDirectoryEffect } from "../external-directory"
import { exec, report } from "./exec"

export const Parameters = Schema.Struct({
  path: Schema.String.annotate({ description: "The file path to touch/create (absolute, or relative to the project)" }),
})

// Structured `touch`. Future semantic permission verb: create.
export const TouchTool = Tool.define(
  "touch",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    return {
      description: "Create an empty file or update its timestamp. Wraps `touch` with structured, typed parameters.",
      parameters: Parameters,
      execute: (params: { path: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const abs = path.isAbsolute(params.path) ? params.path : path.resolve(instance.directory, params.path)

          yield* assertExternalDirectoryEffect(ctx, abs)
          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(instance.worktree, abs)],
            always: [],
            metadata: { path: abs },
          })

          // `--` terminates option parsing (flag-injection guard).
          const result = yield* exec(spawner, "touch", ["--", abs], instance.directory)
          return report({
            binary: "touch",
            result,
            title: path.relative(instance.worktree, abs),
            success: `Touched ${abs}`,
          })
        }).pipe(Effect.orDie),
    }
  }),
)
