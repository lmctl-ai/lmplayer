import { Effect, Schema } from "effect"
import { open } from "node:fs/promises"
import { SessionJobStore, info } from "@/session/job-store"
import { SessionJobRuntime } from "@/session/job-runtime"
import type { SessionID } from "@/session/schema"
import * as Tool from "./tool"

// Anthropic-format tool schemas reject `anyOf`/`oneOf`/`allOf` at the top level of
// `input_schema`, so these must stay flat structs (not a discriminated Schema.Union) even
// though only a subset of fields is meaningful per action. Per-action requirements are
// enforced at runtime by requireJobID below, not by the schema shape itself.
const Parameters = Schema.Struct({
  action: Schema.Literals(["list", "get", "output", "stop"]),
  jobID: Schema.optional(Schema.String),
  offset: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Number),
})

export const SafeParameters = Schema.Struct({
  action: Schema.Literals(["list", "get", "output"]),
  jobID: Schema.optional(Schema.String),
  offset: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Number),
})

const requireJobID = Effect.fn("JobTool.requireJobID")(function* (action: string, jobID: string | undefined) {
  if (!jobID) {
    return yield* Effect.fail(
      new Tool.InvalidArgumentsError({ tool: "job", detail: `jobID is required for action "${action}"` }),
    )
  }
  return jobID
})

export const JobTool = Tool.define(
  "job",
  Effect.gen(function* () {
    const store = yield* SessionJobStore.Service
    const runtime = yield* SessionJobRuntime.Service
    return {
      description:
        "Manage session-scoped background shell jobs. List jobs, inspect metadata, read captured untrusted output, or stop a running job.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx) =>
        Effect.gen(function* () {
          if (params.action === "list") {
            return result("Background jobs", (yield* store.list(ctx.sessionID)).map(info))
          }
          if (params.action === "get") {
            const jobID = yield* requireJobID(params.action, params.jobID)
            return result(jobID, info(yield* store.get(ctx.sessionID, jobID)))
          }
          if (params.action === "stop") {
            const jobID = yield* requireJobID(params.action, params.jobID)
            yield* ctx.ask({
              permission: "job",
              patterns: [`stop:${jobID}`],
              always: [],
              metadata: { jobID },
            })
            return result(jobID, yield* runtime.stop(ctx.sessionID, jobID))
          }
          const jobID = yield* requireJobID(params.action, params.jobID)
          return result(jobID, yield* readOutput(store, ctx.sessionID, jobID, params.offset, params.limit))
        }).pipe(Effect.orDie),
    }
  }),
)

export function safeDefinition(store: SessionJobStore.Interface): Tool.Def<typeof SafeParameters> {
  return {
    id: "job",
    description: "Inspect the background jobs whose completion triggered this unattended turn.",
    parameters: SafeParameters,
    execute: (params: Schema.Schema.Type<typeof SafeParameters>, ctx) =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeUnknownEffect(SafeParameters)(params).pipe(
          Effect.mapError((error) => new Tool.InvalidArgumentsError({ tool: "job", detail: String(error) })),
        )
        if (decoded.action === "list") return result("Background jobs", (yield* store.list(ctx.sessionID)).map(info))
        if (decoded.action === "get") {
          const jobID = yield* requireJobID(decoded.action, decoded.jobID)
          return result(jobID, info(yield* store.get(ctx.sessionID, jobID)))
        }
        const jobID = yield* requireJobID(decoded.action, decoded.jobID)
        return result(jobID, yield* readOutput(store, ctx.sessionID, jobID, decoded.offset, decoded.limit))
      }).pipe(Effect.orDie),
  }
}

export function assertNotificationToolCall(toolID: string, args: unknown) {
  if (toolID !== "job") {
    throw new Tool.InvalidArgumentsError({ tool: toolID, detail: "Notification-origin turns may only call job" })
  }
  try {
    return Schema.decodeUnknownSync(SafeParameters)(args)
  } catch (error) {
    throw new Tool.InvalidArgumentsError({ tool: toolID, detail: String(error) })
  }
}

function result(title: string, value: unknown) {
  return {
    title,
    metadata: {},
    output: JSON.stringify(value),
  }
}

export const readOutput = Effect.fn("JobTool.readOutput")(function* (
  store: SessionJobStore.Interface,
  sessionID: SessionID,
  jobID: string,
  offset = 0,
  requestedLimit = 65_536,
) {
  const row = yield* store.get(sessionID, jobID)
  const limit = Math.min(262_144, Math.max(1, Math.floor(requestedLimit)))
  const expired = () => ({
    jobID,
    startOffset: 0,
    nextOffset: 0,
    totalBytes: row.output_bytes,
    eof: true,
    outputExpired: true,
    untrustedOutput: "",
  })
  if (row.output_expired || row.output_deleting) return expired()

  const token = crypto.randomUUID()
  return yield* Effect.acquireUseRelease(
    store.acquireOutputRead(sessionID, jobID, token, Date.now() + 5 * 60 * 1000),
    (acquired) => {
      if (!acquired) return Effect.succeed(expired())
      return Effect.acquireUseRelease(
        Effect.tryPromise({
          try: () => open(row.output_path, "r"),
          catch: () => undefined,
        }).pipe(Effect.catch(() => Effect.succeed(undefined))),
        (file) => {
          if (!file) {
            return Effect.succeed({
              jobID,
              startOffset: 0,
              nextOffset: 0,
              totalBytes: row.output_bytes,
              eof: row.time_completed !== null,
              outputExpired: false,
              untrustedOutput: "",
            })
          }
          return Effect.gen(function* () {
            const total = Math.min(row.output_bytes, (yield* Effect.promise(() => file.stat())).size)
            const wanted = Math.min(total, Math.max(0, Math.floor(offset)))
            const prefix = new Uint8Array(Math.min(3, Math.max(0, total - wanted)))
            if (prefix.byteLength) yield* Effect.promise(() => file.read(prefix, 0, prefix.byteLength, wanted))
            const skip = continuationSkip(prefix)
            const start = Math.min(total, wanted + skip)
            const buffer = new Uint8Array(Math.min(limit + 3, Math.max(0, total - start)))
            if (buffer.byteLength) yield* Effect.promise(() => file.read(buffer, 0, buffer.byteLength, start))
            const bytes = codePointPrefix(buffer, Math.min(limit, buffer.byteLength))
            const next = start + bytes.byteLength
            return {
              jobID,
              startOffset: start,
              nextOffset: next,
              totalBytes: total,
              eof: row.time_completed !== null && next >= total,
              outputExpired: false,
              untrustedOutput: new TextDecoder().decode(bytes),
            }
          })
        },
        (file) => (file ? Effect.promise(() => file.close()).pipe(Effect.ignore) : Effect.void),
      )
    },
    (acquired) => (acquired ? store.releaseOutputRead(sessionID, jobID, token) : Effect.void),
  )
})

function continuationSkip(bytes: Uint8Array) {
  let index = 0
  while (index < bytes.byteLength && (bytes[index] & 0xc0) === 0x80) index++
  return index
}

function codePointPrefix(bytes: Uint8Array, limit: number) {
  let end = limit
  while (end < bytes.byteLength && (bytes[end] & 0xc0) === 0x80) end++
  return bytes.subarray(0, end)
}
