import path from "path"
import { Effect, Schema } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { InstanceState } from "@/effect/instance-state"
import { Tool } from "../tool"
import { assertExternalDirectoryEffect } from "../external-directory"
import { exec, report } from "./exec"

export const Parameters = Schema.Struct({
  paths: Schema.Array(Schema.String).annotate({
    description: "The paths to remove (absolute, or relative to the project)",
  }),
  recursive: Schema.optional(Schema.Boolean).annotate({ description: "Remove directories and their contents (rm -r)" }),
  force: Schema.optional(Schema.Boolean).annotate({ description: "Ignore nonexistent files, never prompt (rm -f)" }),
})

// Structured `rm`. Future semantic permission verb: delete.
export const RmTool = Tool.define(
  "rm",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    return {
      description: "Remove files or directories. Wraps `rm` with structured, typed parameters.",
      parameters: Parameters,
      execute: (params: { paths: readonly string[]; recursive?: boolean; force?: boolean }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          if (params.paths.length === 0) throw new Error("rm requires at least one path")
          const abs = params.paths.map((p) => (path.isAbsolute(p) ? p : path.resolve(instance.directory, p)))

          // Gate each target outside the worktree behind external_directory first.
          for (const p of abs) yield* assertExternalDirectoryEffect(ctx, p)
          yield* ctx.ask({
            permission: "edit",
            patterns: abs.map((p) => path.relative(instance.worktree, p)),
            always: [],
            metadata: { paths: abs, recursive: params.recursive ?? false, force: params.force ?? false },
          })

          // `--` terminates option parsing so paths like `-rf` are treated as paths.
          const args = [...(params.recursive ? ["-r"] : []), ...(params.force ? ["-f"] : []), "--", ...abs]
          const result = yield* exec(spawner, "rm", args, instance.directory)
          return report({
            binary: "rm",
            result,
            title: abs.map((p) => path.relative(instance.worktree, p)).join(", "),
            success: `Removed ${abs.join(", ")}`,
          })
        }).pipe(Effect.orDie),
    }
  }),
)
