export * as ConfigPaths from "./paths"

import path from "path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { unique } from "remeda"
import * as Effect from "effect/Effect"
import { FSUtil } from "@opencode-ai/core/fs-util"

// lmplayer is standalone: config is NOT merged from parent/ancestor directories.
// Only the start `directory`'s own config file(s) are used (plus the global
// config dir, handled by `directories`). `worktree` is accepted for call-site
// compatibility but intentionally ignored — no walk up to the worktree root.
export const files = Effect.fn("ConfigPaths.projectFiles")(function* (
  name: string,
  directory: string,
  _worktree?: string,
) {
  const afs = yield* FSUtil.Service
  const result: string[] = []
  // json then jsonc so jsonc (merged last) wins, matching the prior ordering.
  for (const file of [path.join(directory, `${name}.json`), path.join(directory, `${name}.jsonc`)]) {
    if (yield* afs.exists(file)) result.push(file)
  }
  return result
})

export const directories = Effect.fn("ConfigPaths.directories")(function* (directory: string, _worktree?: string) {
  const afs = yield* FSUtil.Service
  const own = path.join(directory, ".opencode")
  return unique([
    Global.Path.config,
    // Only the start directory's own `.opencode`, never an ancestor's. Gated by
    // the same flag that disables project config entirely.
    ...(!Flag.OPENCODE_DISABLE_PROJECT_CONFIG && (yield* afs.exists(own)) ? [own] : []),
    ...(Flag.OPENCODE_CONFIG_DIR ? [Flag.OPENCODE_CONFIG_DIR] : []),
  ])
})

export function fileInDirectory(dir: string, name: string) {
  return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
}
