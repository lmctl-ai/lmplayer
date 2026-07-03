import path from "path"
import { Effect, Schema } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { InstanceState } from "@/effect/instance-state"
import { Tool } from "../tool"
import { assertExternalDirectoryEffect } from "../external-directory"
import { exec, report } from "./exec"

export const Parameters = Schema.Struct({
  paths: Schema.Array(Schema.String).annotate({
    description: "The paths to count (absolute, or relative to the project)",
  }),
  lines: Schema.optional(Schema.Boolean).annotate({ description: "Count lines (wc -l)" }),
  words: Schema.optional(Schema.Boolean).annotate({ description: "Count words (wc -w)" }),
  bytes: Schema.optional(Schema.Boolean).annotate({ description: "Count bytes (wc -c)" }),
  chars: Schema.optional(Schema.Boolean).annotate({ description: "Count characters (wc -m)" }),
})

export const WcTool = Tool.define(
  "wc",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    return {
      description: "Count lines, words, bytes, or characters in files. Wraps `wc` with structured, typed parameters.",
      parameters: Parameters,
      execute: (
        params: { paths: readonly string[]; lines?: boolean; words?: boolean; bytes?: boolean; chars?: boolean },
        ctx: Tool.Context,
      ) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          if (params.paths.length === 0) throw new Error("wc requires at least one path")
          const abs = params.paths.map((p) => (path.isAbsolute(p) ? p : path.resolve(instance.directory, p)))

          for (const p of abs) yield* assertExternalDirectoryEffect(ctx, p, { kind: "file" })
          yield* ctx.ask({
            permission: "read",
            patterns: abs.map((p) => path.relative(instance.worktree, p)),
            always: [],
            metadata: {
              paths: abs,
              lines: params.lines ?? false,
              words: params.words ?? false,
              bytes: params.bytes ?? false,
              chars: params.chars ?? false,
            },
          })

          const args = [
            ...(params.lines ? ["-l"] : []),
            ...(params.words ? ["-w"] : []),
            ...(params.bytes ? ["-c"] : []),
            ...(params.chars ? ["-m"] : []),
            "--",
            ...abs,
          ]
          const result = yield* exec(spawner, "wc", args, instance.directory)
          return report({
            binary: "wc",
            result,
            title: abs.map((p) => path.relative(instance.worktree, p)).join(", "),
            success: `Counted ${abs.join(", ")}`,
          })
        }).pipe(Effect.orDie),
    }
  }),
)
