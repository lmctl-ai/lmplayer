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
  recursive: Schema.optional(Schema.Boolean).annotate({ description: "Copy directories recursively (cp -r)" }),
})

// Structured `cp`. Future semantic permission verb: create.
export const CpTool = Tool.define(
  "cp",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    return {
      description: "Copy a file or directory. Wraps `cp` with structured, typed parameters.",
      parameters: Parameters,
      execute: (params: { source: string; dest: string; recursive?: boolean }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const source = path.isAbsolute(params.source) ? params.source : path.resolve(instance.directory, params.source)
          const dest = path.isAbsolute(params.dest) ? params.dest : path.resolve(instance.directory, params.dest)

          // cp READS source and WRITES dest. Gate the source with a read ask
          // (+ external) so a model can't copy arbitrary host files into the
          // workspace, and the dest with an edit ask (+ external).
          yield* assertExternalDirectoryEffect(ctx, source)
          yield* ctx.ask({
            permission: "read",
            patterns: [path.relative(instance.worktree, source)],
            always: [],
            metadata: { source, recursive: params.recursive ?? false },
          })

          yield* assertExternalDirectoryEffect(ctx, dest)
          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(instance.worktree, dest)],
            always: [],
            metadata: { source, dest, recursive: params.recursive ?? false },
          })

          // `--` terminates option parsing (flag-injection guard).
          const args = [...(params.recursive ? ["-r"] : []), "--", source, dest]
          const result = yield* exec(spawner, "cp", args, instance.directory)
          return report({
            binary: "cp",
            result,
            title: `${path.relative(instance.worktree, source)} -> ${path.relative(instance.worktree, dest)}`,
            success: `Copied ${source} to ${dest}`,
          })
        }).pipe(Effect.orDie),
    }
  }),
)
