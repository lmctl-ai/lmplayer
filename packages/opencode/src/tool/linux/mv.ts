import path from "path"
import { Effect, Schema } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { InstanceState } from "@/effect/instance-state"
import { Tool } from "../tool"
import { assertExternalDirectoryEffect } from "../external-directory"
import { exec, report } from "./exec"

export const Parameters = Schema.Struct({
  source: Schema.String.annotate({ description: "The source path (absolute, or relative to the project)" }),
  dest: Schema.String.annotate({ description: "The destination path (absolute, or relative to the project)" }),
})

// Structured `mv`. Future semantic permission verb: modify.
export const MvTool = Tool.define(
  "mv",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    return {
      description: "Move or rename a file or directory. Wraps `mv` with structured, typed parameters.",
      parameters: Parameters,
      execute: (params: { source: string; dest: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const source = path.isAbsolute(params.source) ? params.source : path.resolve(instance.directory, params.source)
          const dest = path.isAbsolute(params.dest) ? params.dest : path.resolve(instance.directory, params.dest)

          // Both source (removed) and dest (written) are mutated — gate each
          // outside the worktree behind external_directory, then ask edit.
          yield* assertExternalDirectoryEffect(ctx, source)
          yield* assertExternalDirectoryEffect(ctx, dest)
          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(instance.worktree, source), path.relative(instance.worktree, dest)],
            always: [],
            metadata: { source, dest },
          })

          // `--` terminates option parsing (flag-injection guard).
          const result = yield* exec(spawner, "mv", ["--", source, dest], instance.directory)
          return report({
            binary: "mv",
            result,
            title: `${path.relative(instance.worktree, source)} -> ${path.relative(instance.worktree, dest)}`,
            success: `Moved ${source} to ${dest}`,
          })
        }).pipe(Effect.orDie),
    }
  }),
)
