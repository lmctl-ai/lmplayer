import type { Argv } from "yargs"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { Session } from "@/session/session"
import { SessionID } from "../../session/schema"
import { UI } from "../ui"
import { Locale } from "@/util/locale"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"
import { NotFoundError } from "@/storage/storage"
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2"
import { EOL } from "os"
import path from "path"
import { which } from "@opencode-ai/core/util/which"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

export type SessionMessage = NonNullable<Awaited<ReturnType<OpencodeClient["session"]["messages"]>>["data"]>[number]

type FileOperation = "write" | "edit" | "add" | "update" | "delete" | "mkdir" | "touch" | "rm" | "mv" | "cp"
type TokenUsage = Extract<SessionMessage["info"], { role: "assistant" }>["tokens"]
const DEFAULT_CONTEXT_LIMIT = 128_000

function pagerCmd(): string[] {
  const lessOptions = ["-R", "-S"]
  if (process.platform !== "win32") {
    return ["less", ...lessOptions]
  }

  // user could have less installed via other options
  const lessOnPath = which("less")
  if (lessOnPath) {
    if (Filesystem.stat(lessOnPath)?.size) return [lessOnPath, ...lessOptions]
  }

  if (Flag.OPENCODE_GIT_BASH_PATH) {
    const less = path.join(Flag.OPENCODE_GIT_BASH_PATH, "..", "..", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }

  const git = which("git")
  if (git) {
    const less = path.join(git, "..", "..", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }

  // Fall back to Windows built-in more (via cmd.exe)
  return ["cmd", "/c", "more"]
}

export const SessionCommand = cmd({
  command: "session",
  describe: "manage sessions",
  builder: (yargs: Argv) =>
    yargs
      .command(SessionLsCommand)
      .command(SessionTailCommand)
      .command(SessionReportCommand)
      .command(SessionMetricsCommand)
      .command(SessionHealthCommand)
      .command(SessionListCommand)
      .command(SessionDeleteCommand)
      .demandCommand(),
  async handler() {},
})

export const SessionLsCommand = effectCmd({
  command: "ls",
  describe: "list sessions",
  builder: (yargs) =>
    yargs.option("json", {
      describe: "output JSON",
      type: "boolean",
    }),
  handler: Effect.fn("Cli.session.ls")(function* (args) {
    const sdk = yield* localSdk()
    yield* Effect.promise(async () => {
      const response = await sdk.session.list()
      const sessions = (response.data ?? []).toSorted((a, b) => b.time.updated - a.time.updated)
      const rows = await Promise.all(
        sessions.map(async (session) => ({
          session,
          messageCount: (await sdk.session.messages({ sessionID: session.id })).data?.length ?? 0,
        })),
      )

      if (args.json) {
        console.log(
          JSON.stringify(
            rows.map((row) => ({
              id: row.session.id,
              title: row.session.title,
              directory: row.session.directory,
              updated: row.session.time.updated,
              messageCount: row.messageCount,
            })),
            null,
            2,
          ),
        )
        return
      }

      rows.forEach((row) => {
        UI.println(row.session.id, row.session.title, row.session.directory)
      })
    })
  }),
})

export const SessionTailCommand = effectCmd({
  command: "tail <sessionID>",
  describe: "print recent session messages",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        describe: "session ID to inspect",
        type: "string",
        demandOption: true,
      })
      .option("n", {
        describe: "number of messages to print",
        type: "number",
        default: 20,
      })
      .option("json", {
        describe: "output JSON",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.session.tail")(function* (args) {
    const sdk = yield* localSdk()
    yield* Effect.promise(async () => {
      const limit = Number.isInteger(args.n) && args.n >= 0 ? args.n : 20
      const response = await sdk.session.messages({ sessionID: args.sessionID, limit })
      const rows = (response.data ?? []).map((message) => ({
        role: message.info.role,
        text: messageText(message),
        time: message.info.time.created,
      }))

      if (args.json) {
        console.log(JSON.stringify(rows, null, 2))
        return
      }

      rows.forEach((row) => {
        UI.println(`${row.role}: ${row.text}`)
      })
    })
  }),
})

export const SessionReportCommand = effectCmd({
  command: "report <sessionID>",
  describe: "report session metrics",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        describe: "session ID to inspect",
        type: "string",
        demandOption: true,
      })
      .option("json", {
        describe: "output JSON",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.session.report")(function* (args) {
    const sdk = yield* localSdk()
    yield* Effect.promise(async () => {
      const response = await sdk.session.messages({ sessionID: args.sessionID })
      const report = createSessionReport(args.sessionID, response.data ?? [])

      if (args.json) {
        console.log(JSON.stringify(report, null, 2))
        return
      }

      console.log(formatSessionReport(report))
    })
  }),
})

export const SessionMetricsCommand = effectCmd({
  command: "metrics <sessionID>",
  describe: "report machine-queryable session metrics (tokens, cost, latency, tools, files)",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        describe: "session ID to inspect",
        type: "string",
        demandOption: true,
      })
      .option("json", {
        describe: "output JSON",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.session.metrics")(function* (args) {
    const sdk = yield* localSdk()
    const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
    // FIX 1: fetch session info first and fail fast if not found
    const info = yield* Effect.promise(() => sdk.session.get({ sessionID: args.sessionID }).then((r) => r.data))
    if (!info) return yield* fail(`Session not found: ${args.sessionID}`)
    // FIX 2: fetch messages before pricing so we can fall back to assistant-message model
    const msgs = yield* Effect.promise(() =>
      sdk.session.messages({ sessionID: args.sessionID }).then((r) => r.data ?? []),
    )
    // Effective model = session.model if present, else latest assistant message model
    const effectiveProviderID = info.model?.providerID ?? latestModel(msgs)?.providerID
    const effectiveModelID = info.model?.id ?? latestModel(msgs)?.modelID
    const resolvePricing =
      effectiveProviderID && effectiveModelID
        ? Provider.Service.use((p) =>
            p.getModel(ProviderV2.ID.make(effectiveProviderID), ModelV2.ID.make(effectiveModelID)),
          ).pipe(
            Effect.map((m) => ({
              input: m.cost.input,
              output: m.cost.output,
              cache: { read: m.cost.cache.read, write: m.cost.cache.write },
            })),
            Effect.orElseSucceed(() => undefined),
          )
        : Effect.succeed(undefined)
    const pricing = yield* resolvePricing
    yield* Effect.promise(async () => {
      const metrics = createSessionMetrics(args.sessionID, msgs, { session: info, pricing })
      if (args.json) {
        console.log(JSON.stringify(metrics, null, 2))
        return
      }
      console.log(formatSessionMetrics(metrics))
    })
  }),
})

export const SessionHealthCommand = effectCmd({
  command: "health <sessionID>",
  describe: "report session context health",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        describe: "session ID to inspect",
        type: "string",
        demandOption: true,
      })
      .option("json", {
        describe: "output JSON",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.session.health")(function* (args) {
    const sdk = yield* localSdk()
    const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
    const providers = yield* Provider.Service.use((provider) => provider.list()).pipe(Effect.orElseSucceed(() => undefined))
    yield* Effect.promise(async () => {
      const response = await sdk.session.messages({ sessionID: args.sessionID })
      const health = createSessionHealth(args.sessionID, response.data ?? [], providers)

      if (args.json) {
        console.log(JSON.stringify(health, null, 2))
        return
      }

      console.log(formatSessionHealth(health))
    })
  }),
})

export const SessionDeleteCommand = effectCmd({
  command: "delete <sessionID>",
  describe: "delete a session",
  builder: (yargs) =>
    yargs.positional("sessionID", {
      describe: "session ID to delete",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.session.delete")(function* (args) {
    const svc = yield* Session.Service
    const sessionID = SessionID.make(args.sessionID)
    yield* svc
      .remove(sessionID)
      .pipe(Effect.catchIf(NotFoundError.isInstance, () => fail(`Session not found: ${args.sessionID}`)))
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Session ${args.sessionID} deleted` + UI.Style.TEXT_NORMAL)
  }),
})

export const SessionListCommand = effectCmd({
  command: "list",
  describe: "list sessions",
  builder: (yargs) =>
    yargs
      .option("max-count", {
        alias: "n",
        describe: "limit to N most recent sessions",
        type: "number",
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.session.list")(function* (args) {
    const sessions = yield* Session.Service.use((svc) => svc.list({ roots: true, limit: args.maxCount }))

    if (sessions.length === 0) return

    const output = args.format === "json" ? formatSessionJSON(sessions) : formatSessionTable(sessions)

    const shouldPaginate = process.stdout.isTTY && !args.maxCount && args.format === "table"

    if (shouldPaginate) {
      yield* Effect.promise(async () => {
        const proc = Process.spawn(pagerCmd(), {
          stdin: "pipe",
          stdout: "inherit",
          stderr: "inherit",
        })

        if (!proc.stdin) {
          console.log(output)
          return
        }

        proc.stdin.write(output)
        proc.stdin.end()
        await proc.exited
      })
    } else {
      console.log(output)
    }
  }),
})

function formatSessionTable(sessions: Session.Info[]): string {
  const lines: string[] = []

  const maxIdWidth = Math.max(20, ...sessions.map((s) => s.id.length))
  const maxTitleWidth = Math.max(25, ...sessions.map((s) => s.title.length))

  const header = `Session ID${" ".repeat(maxIdWidth - 10)}  Title${" ".repeat(maxTitleWidth - 5)}  Updated`
  lines.push(header)
  lines.push("─".repeat(header.length))
  for (const session of sessions) {
    const truncatedTitle = Locale.truncate(session.title, maxTitleWidth)
    const timeStr = Locale.todayTimeOrDateTime(session.time.updated)
    const line = `${session.id.padEnd(maxIdWidth)}  ${truncatedTitle.padEnd(maxTitleWidth)}  ${timeStr}`
    lines.push(line)
  }

  return lines.join(EOL)
}

function formatSessionJSON(sessions: Session.Info[]): string {
  const jsonData = sessions.map((session) => ({
    id: session.id,
    title: session.title,
    updated: session.time.updated,
    created: session.time.created,
    projectId: session.projectID,
    directory: session.directory,
  }))
  return JSON.stringify(jsonData, null, 2)
}

export function createSessionReport(sessionID: string, messages: SessionMessage[]) {
  const text = messages
    .flatMap((message) => message.parts.flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : [])))
    .join("")
  const tokens = emptyTokens()
  const files = new Map<string, ReturnType<typeof emptyFileOperations>>()
  const operations = emptyFileOperations()

  messages.forEach((message) => {
    const finishes = message.parts.flatMap((part) => (part.type === "step-finish" ? [part.tokens] : []))
    if (finishes.length > 0) {
      finishes.forEach((item) => addTokens(tokens, item))
    } else if (message.info.role === "assistant") {
      addTokens(tokens, message.info.tokens)
    }

    message.parts.forEach((part) => {
      if (part.type !== "tool") return
      const seen = new Set<string>()
      touchedFiles(part.tool, part.state.input, part.state.status === "pending" ? undefined : part.state.metadata)
        .filter((item) => {
          const key = `${item.operation}:${item.path}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        .forEach((item) => {
          const current = files.get(item.path) ?? emptyFileOperations()
          current[item.operation]++
          operations[item.operation]++
          files.set(item.path, current)
        })
    })
  })

  const times = messages.map((message) => message.info.time.created)
  const start = times.length > 0 ? Math.min(...times) : null
  const end = times.length > 0 ? Math.max(...times) : null
  const paths = Array.from(files.keys()).toSorted()

  return {
    sessionID,
    messageCount: messages.length,
    text: {
      chars: Array.from(text).length,
      bytes: new TextEncoder().encode(text).byteLength,
    },
    duration: {
      start,
      end,
      milliseconds: start === null || end === null ? null : end - start,
    },
    tokens,
    files: {
      count: paths.length,
      paths,
      operations,
      touched: paths.flatMap((filePath) => {
        const fileOperations = files.get(filePath)
        return fileOperations ? [{ path: filePath, operations: fileOperations }] : []
      }),
    },
  }
}

type SessionInfo = {
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  model?: { id: string; providerID: string }
  cost?: number
}

type Pricing = {
  input: number
  output: number
  cache: { read: number; write: number }
}

export function createSessionMetrics(
  sessionID: string,
  messages: SessionMessage[],
  options?: { session?: SessionInfo; pricing?: Pricing },
) {
  const report = createSessionReport(sessionID, messages)

  // Tokens: prefer persisted session row totals; fall back to summed report tokens
  const sessionTokens = options?.session?.tokens
  const sessionSum = sessionTokens
    ? sessionTokens.input + sessionTokens.output + sessionTokens.reasoning + sessionTokens.cache.read + sessionTokens.cache.write
    : 0
  const baseTokens = sessionTokens && sessionSum > 0 ? sessionTokens : report.tokens
  const tokens = {
    input: baseTokens.input,
    output: baseTokens.output,
    reasoning: baseTokens.reasoning,
    cache: { read: baseTokens.cache.read, write: baseTokens.cache.write },
    total: baseTokens.input + baseTokens.output + baseTokens.reasoning + baseTokens.cache.read + baseTokens.cache.write,
  }

  // Model: prefer persisted session row; fall back to latest assistant message
  const sessionModel = options?.session?.model
  const fallbackModel = latestModel(messages)
  const providerID = sessionModel?.providerID ?? fallbackModel?.providerID ?? null
  const modelID = sessionModel ? sessionModel.id : (fallbackModel?.modelID ?? null)
  const model = providerID && modelID ? `${providerID}/${modelID}` : null

  const turns = messages.filter((m) => m.info.role === "assistant").length

  // Cost: derived from tokens × pricing; 0 when pricing unavailable
  const pricing = options?.pricing
  const costUsd = pricing
    ? (tokens.input * pricing.input +
        tokens.output * pricing.output +
        tokens.reasoning * pricing.output +
        tokens.cache.read * pricing.cache.read +
        tokens.cache.write * pricing.cache.write) /
      1_000_000
    : 0

  // Latency: per-turn durations from assistant time.completed - time.created
  const turnDurations = messages.flatMap((message) => {
    if (message.info.role !== "assistant") return []
    const completed = message.info.time.completed
    if (!completed || completed <= message.info.time.created) return []
    return [completed - message.info.time.created]
  })

  // Tool durations from completed/error tool parts
  const toolDurations = messages
    .flatMap((message) => message.parts.flatMap((part) => (part.type === "tool" ? [part] : [])))
    .flatMap((part) => {
      if (part.state.status !== "completed" && part.state.status !== "error") return []
      const duration = part.state.time.end - part.state.time.start
      return duration < 0 ? [] : [duration]
    })

  const latencyTotal = turnDurations.reduce((a, b) => a + b, 0)
  const toolTotal = toolDurations.reduce((a, b) => a + b, 0)

  // Tools: count of each tool name across all parts
  const tools = messages
    .flatMap((message) => message.parts.flatMap((part) => (part.type === "tool" ? [part.tool] : [])))
    .reduce<Record<string, number>>((acc, tool) => {
      acc[tool] = (acc[tool] ?? 0) + 1
      return acc
    }, {})

  return {
    schema: "session-metrics/v1" as const,
    sessionID,
    model,
    providerID,
    modelID,
    messages: messages.length,
    turns,
    tokens,
    cost_usd: costUsd,
    cost: {
      usd: costUsd,
      source: pricing ? ("derived" as const) : ("unavailable" as const),
      pricing_available: !!pricing,
    },
    latency_ms: {
      total: latencyTotal,
      per_turn_p50: p50(turnDurations),
      per_turn_max: turnDurations.length > 0 ? Math.max(...turnDurations) : 0,
      thinking_total: Math.max(0, latencyTotal - toolTotal),
      tool_total: toolTotal,
      tool_p50: p50(toolDurations),
      tool_max: toolDurations.length > 0 ? Math.max(...toolDurations) : 0,
    },
    tools,
    files: deriveFileBuckets(messages, report.files.paths),
  }
}

export function formatSessionMetrics(metrics: ReturnType<typeof createSessionMetrics>) {
  const lines = [
    `Session: ${metrics.sessionID}`,
    `Model: ${metrics.model ?? "unknown"}`,
    `Messages: ${metrics.messages}, Turns: ${metrics.turns}`,
    `Tokens: total ${metrics.tokens.total}, input ${metrics.tokens.input}, output ${metrics.tokens.output}, reasoning ${metrics.tokens.reasoning}, cache-read ${metrics.tokens.cache.read}, cache-write ${metrics.tokens.cache.write}`,
    `Cost: $${metrics.cost_usd.toFixed(6)} (${metrics.cost.source})`,
    `Latency: total ${metrics.latency_ms.total}ms, p50/turn ${metrics.latency_ms.per_turn_p50}ms, max/turn ${metrics.latency_ms.per_turn_max}ms, thinking ${metrics.latency_ms.thinking_total}ms, tool ${metrics.latency_ms.tool_total}ms (p50 ${metrics.latency_ms.tool_p50}ms, max ${metrics.latency_ms.tool_max}ms)`,
  ]
  const toolEntries = Object.entries(metrics.tools)
  if (toolEntries.length > 0) lines.push(`Tools: ${toolEntries.map(([t, c]) => `${t}:${c}`).join(", ")}`)
  lines.push(
    `Files: created ${metrics.files.created.length}, modified ${metrics.files.modified.length}, deleted ${metrics.files.deleted.length}`,
  )
  return lines.join(EOL)
}

export function createSessionHealth(
  sessionID: string,
  messages: SessionMessage[],
  providers?: Record<ProviderV2.ID, { models: Record<ModelV2.ID, { limit: { context?: number } }> }>,
) {
  const report = createSessionReport(sessionID, messages)
  const model = latestModel(messages)
  const contextLimit = model ? providers?.[ProviderV2.ID.make(model.providerID)]?.models[ModelV2.ID.make(model.modelID)]?.limit.context : undefined
  const limit = contextLimit && contextLimit > 0 ? contextLimit : DEFAULT_CONTEXT_LIMIT
  const usedTokens = report.tokens.input + report.tokens.output + report.tokens.reasoning
  return {
    sessionID,
    messageCount: report.messageCount,
    text: report.text,
    tokens: report.tokens,
    context: {
      used: usedTokens,
      limit,
      limitSource: contextLimit && contextLimit > 0 ? ("model" as const) : ("default" as const),
      percentUsed: limit > 0 ? Math.round((usedTokens / limit) * 10_000) / 100 : null,
      headroom: Math.max(limit - usedTokens, 0),
    },
    model: model ?? null,
    state: {
      hasMessages: messages.length > 0,
      firstMessageAt: report.duration.start,
      lastMessageAt: report.duration.end,
    },
  }
}

function formatSessionReport(report: ReturnType<typeof createSessionReport>) {
  const lines = [
    `Session: ${report.sessionID}`,
    `Messages: ${report.messageCount}`,
    `Text: ${report.text.chars} chars, ${report.text.bytes} bytes`,
    `Duration: ${report.duration.milliseconds ?? 0}ms`,
    `Tokens: total ${report.tokens.total}, input ${report.tokens.input}, output ${report.tokens.output}, reasoning ${report.tokens.reasoning}, cache-read ${report.tokens.cache.read}, cache-write ${report.tokens.cache.write}`,
    `Files: ${report.files.count}`,
  ]
  const operationLines = Object.entries(report.files.operations).flatMap(([operation, count]) =>
    count > 0 ? [`  ${operation}: ${count}`] : [],
  )
  const pathLines = report.files.paths.map((filePath) => `  ${filePath}`)
  return [...lines, ...(operationLines.length > 0 ? ["Operations:", ...operationLines] : []), ...pathLines].join(EOL)
}

export function formatSessionHealth(health: ReturnType<typeof createSessionHealth>) {
  return [
    `Session: ${health.sessionID}`,
    `Messages: ${health.messageCount}`,
    `Text: ${health.text.chars} chars, ${health.text.bytes} bytes`,
    `Tokens: total ${health.tokens.total}, input ${health.tokens.input}, output ${health.tokens.output}, reasoning ${health.tokens.reasoning}, cache-read ${health.tokens.cache.read}, cache-write ${health.tokens.cache.write}`,
    `Context: ${health.context.used} / ${health.context.limit} tokens (${formatPercent(health.context.percentUsed)} used, ${health.context.headroom} headroom, ${health.context.limitSource} limit)`,
    `Model: ${health.model ? `${health.model.providerID}/${health.model.modelID}` : "unknown"}`,
    `State: ${health.state.hasMessages ? "has messages" : "empty"}, first ${health.state.firstMessageAt ?? "n/a"}, last ${health.state.lastMessageAt ?? "n/a"}`,
  ].join(EOL)
}

function formatPercent(value: number | null) {
  if (value === null) return "unknown"
  return `${value.toFixed(2).replace(/\.00$/, "")}%`
}

function latestModel(messages: SessionMessage[]) {
  return messages
    .toReversed()
    .flatMap((message) =>
      message.info.role === "assistant" ? [{ providerID: message.info.providerID, modelID: message.info.modelID }] : [],
    )[0]
}

function emptyTokens() {
  return {
    total: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cache: {
      read: 0,
      write: 0,
    },
  }
}

function addTokens(total: ReturnType<typeof emptyTokens>, next: TokenUsage) {
  total.total += next.total ?? 0
  total.input += next.input
  total.output += next.output
  total.reasoning += next.reasoning
  total.cache.read += next.cache.read
  total.cache.write += next.cache.write
}

function emptyFileOperations(): Record<FileOperation, number> {
  return {
    write: 0,
    edit: 0,
    add: 0,
    update: 0,
    delete: 0,
    mkdir: 0,
    touch: 0,
    rm: 0,
    mv: 0,
    cp: 0,
  }
}

function touchedFiles(tool: string, input: unknown, metadata: unknown) {
  if (tool === "write") return pathFields("write", input, metadata, ["filePath", "filepath"])
  if (tool === "edit") return pathFields("edit", input, metadata, ["filePath", "filepath", "file"])
  if (tool === "mkdir") return pathFields("mkdir", input, metadata, ["path"])
  if (tool === "touch") return pathFields("touch", input, metadata, ["path"])
  if (tool === "rm") return pathArrayFields("rm", input, metadata, ["paths"])
  if (tool === "mv") return pathFields("mv", input, metadata, ["source", "dest"])
  if (tool === "cp") return pathFields("cp", input, metadata, ["source", "dest"])
  if (tool === "apply_patch") return applyPatchFiles(metadata)
  return []
}

function pathFields(operation: FileOperation, input: unknown, metadata: unknown, fields: string[]) {
  return [input, metadata].flatMap((source) => fields.flatMap((field) => pathFromField(source, field))).map((path) => ({
    operation,
    path,
  }))
}

function pathArrayFields(operation: FileOperation, input: unknown, metadata: unknown, fields: string[]) {
  return [input, metadata]
    .flatMap((source) => fields.flatMap((field) => pathsFromField(source, field)))
    .map((path) => ({ operation, path }))
}

function applyPatchFiles(metadata: unknown) {
  const record = asRecord(metadata)
  const value = Array.isArray(record?.files) ? record.files : []
  return value.flatMap((item) => {
    if (typeof item === "string" && item.length > 0) return [{ operation: "update" as const, path: item }]
    const file = asRecord(item)
    const operation = patchOperation(file?.type)
    const filePath = stringValue(file?.filePath) ?? stringValue(file?.relativePath)
    const movePath = stringValue(file?.movePath)
    return [filePath, movePath].flatMap((path) => (path ? [{ operation, path }] : []))
  })
}

function patchOperation(value: unknown): FileOperation {
  if (value === "add") return "add"
  if (value === "delete") return "delete"
  if (value === "move") return "mv"
  return "update"
}

function pathFromField(source: unknown, field: string) {
  const value = asRecord(source)?.[field]
  return typeof value === "string" && value.length > 0 ? [value] : []
}

function pathsFromField(source: unknown, field: string) {
  const value = asRecord(source)?.[field]
  if (typeof value === "string" && value.length > 0) return [value]
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (typeof item === "string" && item.length > 0) return [item]
    const file = asRecord(item)
    return [stringValue(file?.filePath), stringValue(file?.relativePath)].flatMap((path) => (path ? [path] : []))
  })
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function asRecord(value: unknown) {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

// --- Helpers for createSessionMetrics ---

function p50(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = values.toSorted((a, b) => a - b)
  return sorted.at(Math.floor((sorted.length - 1) / 2)) ?? 0
}

function deriveFileBuckets(messages: SessionMessage[], touchedPaths: string[]) {
  const firstBucket = new Map<string, "created" | "modified" | "deleted">()
  messages.forEach((message) => {
    message.parts.forEach((part) => {
      if (part.type !== "tool") return
      const metadata = part.state.status === "pending" ? undefined : part.state.metadata
      bucketedPathOps(part.tool, part.state.input, metadata).forEach(({ path, bucket }) => {
        if (!firstBucket.has(path)) firstBucket.set(path, bucket)
      })
    })
  })

  const created: string[] = []
  const modified: string[] = []
  const deleted: string[] = []
  firstBucket.forEach((bucket, path) => {
    if (bucket === "created") created.push(path)
    if (bucket === "modified") modified.push(path)
    if (bucket === "deleted") deleted.push(path)
  })

  return {
    created: created.toSorted(),
    modified: modified.toSorted(),
    deleted: deleted.toSorted(),
    touched: touchedPaths,
  }
}

function bucketedPathOps(
  tool: string,
  input: unknown,
  metadata: unknown,
): Array<{ path: string; bucket: "created" | "modified" | "deleted" }> {
  if (tool === "write") {
    const inp = asRecord(input)
    const path = stringValue(inp?.filePath) ?? stringValue(inp?.filepath)
    if (!path) return []
    const meta = asRecord(metadata)
    const notExisted = meta?.exists === false || meta?.existed === false
    const existed = !notExisted && (meta?.exists === true || meta?.existed === true)
    const bucket: "created" | "modified" = existed ? "modified" : "created"
    return [{ path, bucket }]
  }
  if (tool === "edit") {
    const inp = asRecord(input)
    const path = stringValue(inp?.filePath) ?? stringValue(inp?.filepath) ?? stringValue(inp?.file)
    return path ? [{ path, bucket: "modified" }] : []
  }
  if (tool === "mkdir" || tool === "touch") {
    const path = stringValue(asRecord(input)?.path)
    return path ? [{ path, bucket: "created" }] : []
  }
  if (tool === "rm") {
    return pathsFromField(input, "paths").map((path) => ({ path, bucket: "deleted" as const }))
  }
  if (tool === "mv") {
    const inp = asRecord(input)
    const results: Array<{ path: string; bucket: "created" | "modified" | "deleted" }> = []
    const src = stringValue(inp?.source)
    const dst = stringValue(inp?.dest)
    if (src) results.push({ path: src, bucket: "deleted" })
    if (dst) results.push({ path: dst, bucket: "created" })
    return results
  }
  if (tool === "cp") {
    const path = stringValue(asRecord(input)?.dest)
    return path ? [{ path, bucket: "created" }] : []
  }
  if (tool === "apply_patch") return applyPatchBuckets(metadata)
  return []
}

function applyPatchBuckets(metadata: unknown): Array<{ path: string; bucket: "created" | "modified" | "deleted" }> {
  const record = asRecord(metadata)
  const value = Array.isArray(record?.files) ? record.files : []
  return value.flatMap((item): Array<{ path: string; bucket: "created" | "modified" | "deleted" }> => {
    if (typeof item === "string" && item.length > 0) return [{ path: item, bucket: "modified" as const }]
    const file = asRecord(item)
    const filePath = stringValue(file?.filePath) ?? stringValue(file?.relativePath)
    if (!filePath) return []
    if (file?.type === "add") return [{ path: filePath, bucket: "created" as const }]
    if (file?.type === "delete") return [{ path: filePath, bucket: "deleted" as const }]
    if (file?.type === "move") {
      const movePath = stringValue(file?.movePath)
      const results: Array<{ path: string; bucket: "created" | "modified" | "deleted" }> = []
      if (filePath) results.push({ path: filePath, bucket: "deleted" })
      if (movePath) results.push({ path: movePath, bucket: "created" })
      return results
    }
    return [{ path: filePath, bucket: "modified" as const }]
  })
}

const localSdk = Effect.fn("Cli.session.localSdk")(function* () {
  const { ServerAuth } = yield* Effect.promise(() => import("@/server/auth"))
  return createOpencodeClient({
    baseUrl: "http://opencode.internal",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const { Server } = await import("@/server/server")
      const request = new Request(input, init)
      const headers = new Headers(request.headers)
      const auth = ServerAuth.header()
      if (auth) headers.set("Authorization", auth)
      return Server.Default().app.fetch(new Request(request, { headers }))
    }) as typeof globalThis.fetch,
    directory: process.cwd(),
  })
})

function messageText(message: SessionMessage) {
  const text = message.parts
    .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : []))
    .join("")
    .trim()
  if (text) return text

  const tools = message.parts.flatMap((part) => (part.type === "tool" ? [toolMarker(part)] : []))
  if (tools.length > 0) return tools.join(" ")

  return ""
}

function toolMarker(part: Extract<SessionMessage["parts"][number], { type: "tool" }>) {
  if (part.state.status === "completed") return `[tool:${part.tool} completed]`
  if (part.state.status === "error") return `[tool:${part.tool} error]`
  return `[tool:${part.tool} ${part.state.status}]`
}
