// Verbose LLM file logging (gated by RuntimeFlags.llmVerbose /
// LMPLAYER_LLM_VERBOSE=1). Appends one JSON object per line to a dedicated
// file so we can debug tool-call issues (e.g. qwen2.5 emitting malformed
// tool-call JSON) without touching the normal opencode.log stream.
//
// R = never: this is called from LLM.Service.stream, whose return type is
// `Stream.Stream<LLMEvent, unknown>` (no R). We deliberately do NOT depend on
// the Effect FileSystem service — that would leak a requirement into every
// caller of stream(). Plain Node `fs/promises` wrapped in `Effect.promise`
// keeps this R=never.
//
// A verbose-log write must NEVER fail the LLM turn: every write is wrapped in
// `Effect.ignore` so a full disk, a permissions error, etc. is swallowed.
import { appendFile, mkdir } from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Effect } from "effect"

const VERBOSE_LOG_FILE = path.join(Global.Path.log, "llm-verbose.log")

export function file(): string {
  return VERBOSE_LOG_FILE
}

// Breaks circular references and normalizes values JSON.stringify can't
// represent natively (Error, bigint) so a single bad record can never throw
// and take down the (already best-effort) write.
function replacer() {
  const seen = new WeakSet<object>()
  return (_key: string, value: unknown) => {
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack }
    if (typeof value === "bigint") return value.toString()
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular]"
      seen.add(value)
    }
    return value
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, replacer())
  } catch {
    try {
      return JSON.stringify(String(value))
    } catch {
      return `"[unserializable ${typeof value}]"`
    }
  }
}

function writeLine(record: Record<string, unknown>) {
  return Effect.promise(async () => {
    await mkdir(path.dirname(VERBOSE_LOG_FILE), { recursive: true })
    await appendFile(VERBOSE_LOG_FILE, safeStringify(record) + "\n", "utf8")
  }).pipe(Effect.ignore)
}

export type RequestInput = {
  sessionID: string
  providerID: unknown
  modelID: unknown
  chatOnly: boolean
  toolNames: string[]
  tools: unknown
  messages: unknown
  params: unknown
  headers: unknown
}

// Logs the fully prepared outgoing request: messages, tool schemas, params,
// and headers. Called once per turn, before the native/ai-sdk runtime branch.
export function request(input: RequestInput) {
  return writeLine({
    t: new Date().toISOString(),
    kind: "request",
    sessionID: input.sessionID,
    providerID: input.providerID,
    modelID: input.modelID,
    chatOnly: input.chatOnly,
    toolNames: input.toolNames,
    tools: input.tools,
    messages: input.messages,
    params: input.params,
    headers: input.headers,
  })
}

// Logs one raw streamed event (tool-input-start/delta/end — the raw JSON
// text the model emits for tool args —, tool-call, tool-error, error, or a
// raw provider chunk when includeRawChunks is on).
export function event(sessionID: string, event: unknown) {
  return writeLine({
    t: new Date().toISOString(),
    kind: "event",
    sessionID,
    event,
  })
}

export * as LLMVerbose from "./verbose"
