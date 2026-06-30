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

// The organize pass maintains a single bounded, curated markdown "brain" for the
// session. It is injected as system context every turn (see prompt.ts), so it
// must stay compact: a full REWRITE that merges the prior index with new salient
// facts, not an append. Modeled loosely on the compaction SUMMARY_TEMPLATE, but
// framed as a persistent merged index rather than a one-off summary.
const ORGANIZE_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Current State
- [where things stand right now, or "(none)"]

## Open Threads / Next Steps
- [ordered open questions or next actions, or "(none)"]

## Critical Context
- [important technical facts, identifiers, errors, or "(none)"]

## Relevant Files & Commands
- [file/dir path or command: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers verbatim.
- MERGE the prior memory with new salient facts from the recent conversation; DROP stale or duplicated info.
- REWRITE the whole memory; do not append. Keep it compact — it is reloaded as context every turn.
- Do not mention this maintenance process or that context was compacted.`

export function buildOrganizePrompt(prior: string | undefined) {
  const priorBlock = prior?.trim()
    ? `Here is the current durable memory (your prior brain) to merge and update:\n\n${prior.trim()}`
    : `There is no prior durable memory yet; create the first version from the conversation.`
  return `${priorBlock}\n\n${ORGANIZE_TEMPLATE}`
}

export * as SessionDurableMemory from "./durable-memory"
