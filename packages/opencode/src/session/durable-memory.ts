import path from "path"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"

// Per-session durable-memory lives under its own top-level dir (NOT under
// `storage/`, which holds JSON records). Keeping it separate avoids colliding
// with Storage's key namespace while still being session-scoped on disk.
export function dir(sessionID: string) {
  return path.join(Global.Path.data, "session", sessionID, "durable-memory")
}

export function indexPath(sessionID: string) {
  return path.join(dir(sessionID), "index.md")
}

export const read = Effect.fn("SessionDurableMemory.read")(function* (sessionID: string) {
  const fs = yield* FSUtil.Service
  return yield* fs.readFileStringSafe(indexPath(sessionID))
})

export const write = Effect.fn("SessionDurableMemory.write")(function* (sessionID: string, content: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(indexPath(sessionID), content)
})

export * as SessionDurableMemory from "./durable-memory"
