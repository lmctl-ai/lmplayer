import type { Argv } from "yargs"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "../../session/schema"
import { UI } from "../ui"
import { Locale } from "@/util/locale"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"
import { NotFoundError } from "@/storage/storage"
import { createOpencodeClient, type OpencodeClient, type SessionJobInfo } from "@opencode-ai/sdk/v2"
import { EOL } from "os"
import path from "path"
import { which } from "@opencode-ai/core/util/which"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Provider } from "@/provider/provider"
import { SessionShare } from "@/share/session"
import { SessionJob } from "@opencode-ai/schema/session-job"
import { SessionCronRuntime } from "@/session/cron-runtime"
import { ExportCommand } from "./export"
import { ImportCommand } from "./import"
import { SessionDurableMemory } from "@/session/durable-memory"
import { FSUtil } from "@opencode-ai/core/fs-util"

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

function* writeOutputFile(filePath: string, content: string, label: string) {
  const resolved = path.resolve(filePath)
  yield* Effect.promise(async () => {
    const fs = await import("fs/promises")
    await fs.mkdir(path.dirname(resolved), { recursive: true })
    await fs.writeFile(resolved, content, "utf-8")
  })
  UI.println(`Wrote ${label} to ${resolved}`)
}

export const SessionCommand = cmd({
  command: "session",
  describe: "manage sessions",
  builder: (yargs: Argv) =>
    yargs
      .command(SessionLsCommand)
      .command(SessionShowCommand)
      .command(SessionStatusCommand)
      .command(SessionTailCommand)
      .command(SessionReportCommand)
      .command(SessionMetricsCommand)
      .command(SessionHealthCommand)
      .command(SessionListCommand)
      .command(SessionDeleteCommand)
      .command(SessionRenameCommand)
      .command(SessionForkCommand)
      .command(SessionShareCommand)
      .command(SessionUnshareCommand)
      .command(SessionCompactCommand)
      .command(SessionJobsCommand)
      .command(SessionCronsCommand)
      .command(SessionTodoCommand)
      .command(SessionDiffCommand)
      .command(SessionExportCommand)
      .command(SessionImportCommand)
      .command(SessionMemoryCommand)
      .demandCommand(),
  async handler() {},
})

export const SessionLsCommand = effectCmd({
  command: "ls",
  describe: "list sessions",
  builder: (yargs) =>
    yargs
      .option("limit", {
        alias: ["n", "max-count"],
        describe: "limit number of sessions",
        type: "number",
      })
      .option("roots", {
        describe: "only show root sessions",
        type: "boolean",
      })
      .option("all", {
        alias: ["a"],
        describe: "show sessions across all projects (global)",
        type: "boolean",
      })
      .option("search", {
        alias: ["q"],
        describe: "filter sessions by title",
        type: "string",
      })
      .option("output", {
        alias: "o",
        describe: "write sessions list to output file path",
        type: "string",
      })
      .option("json", {
        describe: "output JSON",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.session.ls")(function* (args: {
    limit?: number
    roots?: boolean
    all?: boolean
    search?: string
    output?: string
    json?: boolean
  }) {
    const limit = Number.isInteger(args.limit) && (args.limit as number) > 0 ? (args.limit as number) : undefined
    const svc = yield* Session.Service
    const sessions = yield* (args.all
      ? svc.listGlobal({ roots: args.roots, search: args.search, limit })
      : svc.list({ roots: args.roots, search: args.search, limit }))

    let sortedSessions = [...sessions].sort((a, b) => b.time.updated - a.time.updated)
    if (limit !== undefined && sortedSessions.length > limit) {
      sortedSessions = sortedSessions.slice(0, limit)
    }

    const rows = yield* Effect.forEach(
      sortedSessions,
      (session) =>
        svc
          .messages({ sessionID: session.id })
          .pipe(
            Effect.map((msgs) => ({ session, messageCount: msgs.length })),
            Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed({ session, messageCount: 0 })),
            Effect.orElseSucceed(() => ({ session, messageCount: 0 })),
          ),
      { concurrency: 10 },
    )

    if (args.json) {
      const payload = rows.map((row) => ({
        id: row.session.id,
        title: row.session.title,
        directory: row.session.directory,
        updated: row.session.time.updated,
        created: row.session.time.created,
        cost: row.session.cost ?? 0,
        tokens: row.session.tokens,
        messageCount: row.messageCount,
      }))
      const jsonStr = JSON.stringify(payload, null, 2) + EOL
      if (args.output) {
        yield* writeOutputFile(args.output, jsonStr, "sessions list")
        return
      }
      process.stdout.write(jsonStr)
      return
    }

    if (args.output) {
      const lines = rows.map((row) => `${row.session.id} ${row.session.title} ${row.session.directory}`)
      yield* writeOutputFile(args.output, lines.join(EOL) + (lines.length > 0 ? EOL : ""), "sessions list")
      return
    }

    rows.forEach((row) => {
      UI.println(row.session.id, row.session.title, row.session.directory)
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
      .option("lines", {
        alias: ["n", "limit"],
        describe: "number of messages to print",
        type: "number",
        default: 20,
      })
      .option("output", {
        alias: "o",
        describe: "write messages to output file path",
        type: "string",
      })
      .option("json", {
        describe: "output JSON",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.session.tail")(function* (args: {
    sessionID: string
    lines?: number
    n?: number
    limit?: number
    output?: string
    json?: boolean
  }) {
    const sdk = yield* localSdk()
    const info = yield* Effect.promise(() => sdk.session.get({ sessionID: args.sessionID }).then((r) => r.data))
    if (!info) return yield* fail(`Session not found: ${args.sessionID}`)

    const count = args.lines ?? (args as any).n ?? (args as any).limit
    const limit = Number.isInteger(count) && count >= 0 ? count : 20
    const response = yield* Effect.promise(() => sdk.session.messages({ sessionID: args.sessionID, limit }))
    const rows = (response.data ?? []).map((message) => {
      if (message.info.role === "assistant") {
        return {
          id: message.info.id,
          role: message.info.role,
          text: messageText(message),
          time: message.info.time.created,
          model: message.info.modelID ? `${message.info.providerID}/${message.info.modelID}` : undefined,
          cost: message.info.cost,
          tokens: message.info.tokens,
        }
      }
      return {
        id: message.info.id,
        role: message.info.role,
        text: messageText(message),
        time: message.info.time.created,
      }
    })

    if (args.json) {
      const jsonStr = JSON.stringify(rows, null, 2) + EOL
      if (args.output) {
        yield* writeOutputFile(args.output, jsonStr, "messages")
        return
      }
      process.stdout.write(jsonStr)
      return
    }

    if (args.output) {
      const textLines = rows.map((row) => `${row.role}: ${row.text}`)
      yield* writeOutputFile(args.output, textLines.join(EOL) + (textLines.length > 0 ? EOL : ""), "messages")
      return
    }

    rows.forEach((row) => {
      UI.println(`${row.role}: ${row.text}`)
    })
  }),
})

export const SessionShowCommand = effectCmd({
  command: "show <sessionID>",
  aliases: ["get"],
  describe: "show detailed session information",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        describe: "session ID to inspect",
        type: "string",
        demandOption: true,
      })
      .option("output", {
        alias: "o",
        describe: "write session details to output file path",
        type: "string",
      })
      .option("json", {
        describe: "output JSON",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.session.show")(function* (args: {
    sessionID: string
    output?: string
    json?: boolean
  }) {
    const sdk = yield* localSdk()
    const info = yield* Effect.promise(() => sdk.session.get({ sessionID: args.sessionID }).then((r) => r.data))
    if (!info) return yield* fail(`Session not found: ${args.sessionID}`)

    const msgs = yield* Effect.promise(() =>
      sdk.session.messages({ sessionID: args.sessionID }).then((r) => r.data ?? []),
    )

    const sessionTokens = info.tokens
    const sessionSum = sessionTokens
      ? sessionTokens.input +
        sessionTokens.output +
        sessionTokens.reasoning +
        sessionTokens.cache.read +
        sessionTokens.cache.write
      : 0

    let inputTokens = sessionTokens?.input ?? 0
    let outputTokens = sessionTokens?.output ?? 0
    let reasoningTokens = sessionTokens?.reasoning ?? 0
    let cacheReadTokens = sessionTokens?.cache?.read ?? 0
    let cacheWriteTokens = sessionTokens?.cache?.write ?? 0
    let totalCost = info.cost ?? 0

    let userTurns = 0
    let assistantTurns = 0
    let toolCalls = 0

    for (const msg of msgs) {
      if (msg.info.role === "user") {
        userTurns++
      } else if (msg.info.role === "assistant") {
        assistantTurns++
        if (sessionSum === 0 && msg.info.tokens) {
          inputTokens += msg.info.tokens.input ?? 0
          outputTokens += msg.info.tokens.output ?? 0
          reasoningTokens += msg.info.tokens.reasoning ?? 0
          cacheReadTokens += msg.info.tokens.cache?.read ?? 0
          cacheWriteTokens += msg.info.tokens.cache?.write ?? 0
        }
        if (totalCost === 0 && msg.info.cost) {
          totalCost += msg.info.cost
        }
        for (const part of msg.parts) {
          if (part.type === "tool") {
            toolCalls++
          }
        }
      }
    }

    const totalTokens = inputTokens + outputTokens + reasoningTokens + cacheReadTokens + cacheWriteTokens
    const fallbackModel = latestModel(msgs)
    const effectiveModel = info.model?.id ?? fallbackModel?.modelID ?? null
    const effectiveProvider = info.model?.providerID ?? fallbackModel?.providerID ?? null
    const modelVariant = (info.model as any)?.variant ?? null
    const directory = (info as any).directory ?? (info as any).location?.directory ?? null

    const memoryInfo = yield* SessionDurableMemory.read(args.sessionID).pipe(
      Effect.map((content) => {
        const exists = Boolean(content && content.trim().length > 0)
        return {
          exists,
          bytes: exists && content ? Buffer.byteLength(content, "utf-8") : 0,
        }
      }),
      Effect.orElseSucceed(() => ({ exists: false, bytes: 0 })),
    )

    const shareUrl = (info as any).share?.url ?? (info as any).share_url ?? null
    const statusRes = yield* Effect.promise(() =>
      sdk.session
        .status()
        .then((r) => r.data?.[args.sessionID] ?? { type: "idle" as const })
        .catch(() => ({ type: "idle" as const })),
    )

    if (args.json) {
      const jsonStr =
        JSON.stringify(
          {
            id: info.id,
            title: info.title,
            parentID: info.parentID ?? null,
            projectID: (info as any).projectID ?? null,
            directory,
            agent: info.agent ?? null,
            model: effectiveModel
              ? {
                  providerID: effectiveProvider,
                  modelID: effectiveModel,
                  ...(modelVariant ? { variant: modelVariant } : {}),
                }
              : null,
            time: {
              created: info.time.created,
              updated: info.time.updated,
            },
            messages: msgs.length,
            cost: totalCost,
            tokens: {
              input: inputTokens,
              output: outputTokens,
              reasoning: reasoningTokens,
              cache: {
                read: cacheReadTokens,
                write: cacheWriteTokens,
              },
              total: totalTokens,
            },
            turns: {
              user: userTurns,
              assistant: assistantTurns,
              tool: toolCalls,
            },
            memory: memoryInfo,
            status: statusRes,
            share: shareUrl ? { url: shareUrl } : null,
          },
          null,
          2,
        ) + EOL
      if (args.output) {
        yield* writeOutputFile(args.output, jsonStr, "session details")
        return
      }
      process.stdout.write(jsonStr)
      return
    }

    if (args.output) {
      const lines = [
        `${info.title} (${info.id})`,
        ...(directory ? [`  Directory:  ${directory}`] : []),
        ...(info.parentID ? [`  Parent:     ${info.parentID}`] : []),
        ...(effectiveModel ? [`  Model:      ${effectiveProvider}/${effectiveModel}${modelVariant ? ` (${modelVariant})` : ""}`] : []),
        ...(info.agent ? [`  Agent:      ${info.agent}`] : []),
        `  Status:     ${statusRes.type}`,
        `  Created:    ${Locale.todayTimeOrDateTime(info.time.created)}`,
        `  Updated:    ${Locale.todayTimeOrDateTime(info.time.updated)}`,
        `  Messages:   ${msgs.length} (${userTurns} user, ${assistantTurns} assistant${toolCalls > 0 ? `, ${toolCalls} tool calls` : ""})`,
        `  Tokens:     ${totalTokens.toLocaleString()} (in: ${inputTokens.toLocaleString()}, out: ${outputTokens.toLocaleString()}${reasoningTokens > 0 ? `, reasoning: ${reasoningTokens.toLocaleString()}` : ""}${cacheReadTokens > 0 ? `, cache read: ${cacheReadTokens.toLocaleString()}` : ""})`,
        `  Cost:       $${totalCost.toFixed(4)}`,
        ...(memoryInfo.exists ? [`  Memory:     recorded (${memoryInfo.bytes} bytes)`] : []),
        ...(shareUrl ? [`  Share:      ${shareUrl}`] : []),
      ]
      yield* writeOutputFile(args.output, lines.join(EOL) + EOL, "session details")
      return
    }

    UI.println(UI.Style.TEXT_NORMAL_BOLD + `${info.title}` + UI.Style.TEXT_NORMAL + ` (${info.id})`)
    if (directory) {
      UI.println(`  Directory:  ${directory}`)
    }
    if (info.parentID) {
      UI.println(`  Parent:     ${info.parentID}`)
    }
    if (effectiveModel) {
      UI.println(`  Model:      ${effectiveProvider}/${effectiveModel}${modelVariant ? ` (${modelVariant})` : ""}`)
    }
    if (info.agent) {
      UI.println(`  Agent:      ${info.agent}`)
    }
    UI.println(`  Status:     ${statusRes.type}`)
    UI.println(`  Created:    ${Locale.todayTimeOrDateTime(info.time.created)}`)
    UI.println(`  Updated:    ${Locale.todayTimeOrDateTime(info.time.updated)}`)
    UI.println(
      `  Messages:   ${msgs.length} (${userTurns} user, ${assistantTurns} assistant${toolCalls > 0 ? `, ${toolCalls} tool calls` : ""})`,
    )
    UI.println(
      `  Tokens:     ${totalTokens.toLocaleString()} (in: ${inputTokens.toLocaleString()}, out: ${outputTokens.toLocaleString()}${reasoningTokens > 0 ? `, reasoning: ${reasoningTokens.toLocaleString()}` : ""}${cacheReadTokens > 0 ? `, cache read: ${cacheReadTokens.toLocaleString()}` : ""})`,
    )
    UI.println(`  Cost:       $${totalCost.toFixed(4)}`)
    if (memoryInfo.exists) {
      UI.println(`  Memory:     recorded (${memoryInfo.bytes} bytes)`)
    }
    if (shareUrl) {
      UI.println(`  Share:      ${shareUrl}`)
    }
  }),
})

export const SessionStatusCommand = effectCmd({
  command: "status [sessionID]",
  describe: "show runtime status of sessions",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        describe: "session ID to inspect status for",
        type: "string",
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write status to output file path",
      })
      .option("json", {
        describe: "output JSON",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.session.status")(function* (args: {
    sessionID?: string
    output?: string
    json?: boolean
  }) {
    const sdk = yield* localSdk()
    const statusRes = yield* Effect.promise(() => sdk.session.status())
    const statusMap = statusRes.data ?? {}

    if (args.sessionID) {
      const info = yield* Effect.promise(() => sdk.session.get({ sessionID: args.sessionID! }).then((r) => r.data))
      if (!info) return yield* fail(`Session not found: ${args.sessionID}`)

      const status = statusMap[args.sessionID] ?? { type: "idle" as const }
      if (args.json) {
        const jsonStr =
          JSON.stringify(
            {
              id: args.sessionID,
              status,
            },
            null,
            2,
          ) + EOL
        if (args.output) {
          yield* writeOutputFile(args.output, jsonStr, "status")
          return
        }
        process.stdout.write(jsonStr)
        return
      }

      let text = `Session ${args.sessionID}: idle`
      if (status.type === "busy") {
        text = `Session ${args.sessionID}: busy (active run in progress)`
      } else if (status.type === "retry") {
        text = `Session ${args.sessionID}: retry (attempt ${status.attempt}: ${status.message})`
      }

      if (args.output) {
        yield* writeOutputFile(args.output, text + EOL, "status")
        return
      }

      if (status.type === "idle") {
        UI.println(`Session ${args.sessionID}: idle`)
      } else if (status.type === "busy") {
        UI.println(
          UI.Style.TEXT_WARNING_BOLD +
            `Session ${args.sessionID}: busy (active run in progress)` +
            UI.Style.TEXT_NORMAL,
        )
      } else if (status.type === "retry") {
        UI.println(
          UI.Style.TEXT_WARNING_BOLD +
            `Session ${args.sessionID}: retry (attempt ${status.attempt}: ${status.message})` +
            UI.Style.TEXT_NORMAL,
        )
      }
      return
    }

    const entries = Object.entries(statusMap)
    if (args.json) {
      const jsonStr = JSON.stringify(statusMap, null, 2) + EOL
      if (args.output) {
        yield* writeOutputFile(args.output, jsonStr, "status")
        return
      }
      process.stdout.write(jsonStr)
      return
    }

    if (args.output) {
      const lines =
        entries.length === 0
          ? ["No active sessions (all sessions idle)"]
          : entries.map(([id, s]) => {
              const typeStr =
                s.type === "busy" ? "busy" : s.type === "retry" ? `retry (attempt ${s.attempt})` : s.type
              return `${id}: ${typeStr}`
            })
      yield* writeOutputFile(args.output, lines.join(EOL) + EOL, "status")
      return
    }

    if (entries.length === 0) {
      UI.println("No active sessions (all sessions idle)")
      return
    }

    for (const [id, s] of entries) {
      const typeStr =
        s.type === "busy" ? "busy" : s.type === "retry" ? `retry (attempt ${s.attempt})` : s.type
      UI.println(`${id}: ${typeStr}`)
    }
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
      .option("output", {
        alias: "o",
        describe: "write report to output file path",
        type: "string",
      })
      .option("json", {
        describe: "output JSON",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.session.report")(function* (args: {
    sessionID: string
    output?: string
    json?: boolean
  }) {
    const sdk = yield* localSdk()
    const info = yield* Effect.promise(() => sdk.session.get({ sessionID: args.sessionID }).then((r) => r.data))
    if (!info) return yield* fail(`Session not found: ${args.sessionID}`)
    yield* Effect.promise(async () => {
      const response = await sdk.session.messages({ sessionID: args.sessionID })
      const report = createSessionReport(args.sessionID, response.data ?? [])

      if (args.json) {
        const jsonOutput = JSON.stringify(report, null, 2)
        if (args.output) {
          const resolved = path.resolve(args.output)
          const fs = await import("fs/promises")
          await fs.mkdir(path.dirname(resolved), { recursive: true })
          await fs.writeFile(resolved, jsonOutput + EOL, "utf-8")
          console.log(JSON.stringify({ ok: true, file: resolved }, null, 2))
          return
        }
        console.log(jsonOutput)
        return
      }

      const outputText = formatSessionReport(report)
      if (args.output) {
        const resolved = path.resolve(args.output)
        const fs = await import("fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        await fs.writeFile(resolved, outputText + EOL, "utf-8")
        UI.println(`Wrote report to ${resolved}`)
        return
      }

      console.log(outputText)
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
      .option("output", {
        alias: "o",
        describe: "write metrics to output file path",
        type: "string",
      })
      .option("json", {
        describe: "output JSON",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.session.metrics")(function* (args: {
    sessionID: string
    output?: string
    json?: boolean
  }) {
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
    const jobs = yield* Effect.promise(() =>
      sdk.session.jobs({ sessionID: args.sessionID }).then((r) => r.data ?? []).catch(() => []),
    )
    const cronRuntime = yield* SessionCronRuntime.Service
    const crons = yield* cronRuntime.list(args.sessionID as SessionID).pipe(Effect.orElseSucceed(() => []))
    yield* Effect.promise(async () => {
      const metrics = createSessionMetrics(args.sessionID, msgs, { session: info, pricing, jobs, crons })
      if (args.json) {
        const jsonOutput = JSON.stringify(metrics, null, 2)
        if (args.output) {
          const resolved = path.resolve(args.output)
          const fs = await import("fs/promises")
          await fs.mkdir(path.dirname(resolved), { recursive: true })
          await fs.writeFile(resolved, jsonOutput + EOL, "utf-8")
          console.log(JSON.stringify({ ok: true, file: resolved }, null, 2))
          return
        }
        console.log(jsonOutput)
        return
      }

      const outputText = formatSessionMetrics(metrics)
      if (args.output) {
        const resolved = path.resolve(args.output)
        const fs = await import("fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        await fs.writeFile(resolved, outputText + EOL, "utf-8")
        UI.println(`Wrote metrics to ${resolved}`)
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
      .option("output", {
        alias: "o",
        describe: "write health report to output file path",
        type: "string",
      })
      .option("threshold", {
        alias: "t",
        describe: "context usage warning threshold percentage (default: 80)",
        type: "number",
      })
      .option("check", {
        describe: "exit with code 2 if context usage meets or exceeds threshold",
        type: "boolean",
      })
      .option("json", {
        describe: "output JSON",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.session.health")(function* (args: {
    sessionID: string
    output?: string
    threshold?: number
    check?: boolean
    json?: boolean
  }) {
    const sdk = yield* localSdk()
    const info = yield* Effect.promise(() => sdk.session.get({ sessionID: args.sessionID }).then((r) => r.data))
    if (!info) return yield* fail(`Session not found: ${args.sessionID}`)
    const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
    const providers = yield* Provider.Service.use((provider) => provider.list()).pipe(
      Effect.orElseSucceed(() => undefined),
    )
    const threshold = args.threshold !== undefined && !isNaN(args.threshold) ? args.threshold : 80

    const health = yield* Effect.promise(async () => {
      const response = await sdk.session.messages({ sessionID: args.sessionID })
      return createSessionHealth(args.sessionID, response.data ?? [], providers)
    })

    const exceeded = Boolean(
      args.check && health.context.percentUsed !== null && health.context.percentUsed >= threshold,
    )

    if (args.json) {
      const jsonPayload = {
        ...health,
        healthCheck: args.check
          ? {
              threshold,
              exceeded,
              status: exceeded ? "warning" : "ok",
            }
          : undefined,
      }
      const jsonOutput = JSON.stringify(jsonPayload, null, 2)
      if (args.output) {
        const resolved = path.resolve(args.output)
        yield* Effect.promise(async () => {
          const fs = await import("fs/promises")
          await fs.mkdir(path.dirname(resolved), { recursive: true })
          await fs.writeFile(resolved, jsonOutput + EOL, "utf-8")
        })
        console.log(JSON.stringify({ ok: true, file: resolved }, null, 2))
      } else {
        console.log(jsonOutput)
      }
      if (exceeded) {
        process.exitCode = 2
      }
      return
    }

    const outputText = formatSessionHealth(health)
    if (args.output) {
      const resolved = path.resolve(args.output)
      yield* Effect.promise(async () => {
        const fs = await import("fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        await fs.writeFile(resolved, outputText + EOL, "utf-8")
      })
      UI.println(`Wrote health report to ${resolved}`)
    } else {
      console.log(outputText)
    }

    if (exceeded) {
      UI.println(
        UI.Style.TEXT_WARNING_BOLD +
          `[WARNING] Context usage ${health.context.percentUsed}% meets or exceeds threshold ${threshold}%` +
          UI.Style.TEXT_NORMAL,
      )
      process.exitCode = 2
    }
  }),
})

export const SessionDeleteCommand = effectCmd({
  command: "delete <sessionID> [extraSessionIDs..]",
  aliases: ["rm"],
  describe: "delete one or more sessions",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        describe: "session ID to delete",
        type: "string",
        demandOption: true,
      })
      .positional("extraSessionIDs", {
        describe: "additional session IDs to delete",
        type: "string",
      })
      .option("force", {
        alias: ["f"],
        describe: "ignore non-existent sessions, never error",
        type: "boolean",
      })
      .option("output", {
        alias: "o",
        describe: "write delete result to output file path",
        type: "string",
      })
      .option("json", {
        describe: "output JSON",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.session.delete")(function* (args) {
    const ids = [args.sessionID, ...(((args.extraSessionIDs as unknown) as string[] | undefined) ?? [])]
    const force = Boolean(args.force ?? (args as any).f)
    const output = args.output ?? (args as any).o
    const isJson = Boolean(args.json)
    const sdk = yield* localSdk()

    const deleted: string[] = []
    const notFound: string[] = []
    const errors: Array<{ id: string; error: string }> = []

    for (const id of ids) {
      const result = yield* Effect.promise(async () => {
        return sdk.session.delete({
          sessionID: id,
        })
      })
      if (result.error) {
        const msg =
          (result.error as { message?: string } | undefined)?.message ?? `Session not found: ${id}`
        if (force) {
          notFound.push(id)
        } else {
          errors.push({ id, error: msg })
        }
      } else {
        deleted.push(id)
      }
    }

    if (errors.length > 0) {
      if (output) {
        if (isJson) {
          yield* writeOutputFile(output, JSON.stringify({ deleted, notFound, errors }, null, 2), "delete result")
        } else {
          const lines = [
            ...deleted.map((id) => `Session ${id} deleted`),
            ...errors.map((e) => `Error deleting ${e.id}: ${e.error}`),
          ]
          yield* writeOutputFile(output, lines.join(EOL) + EOL, "delete result")
        }
      }
      if (isJson) {
        process.stdout.write(JSON.stringify({ deleted, notFound, errors }, null, 2) + "\n")
      }
      return yield* fail(errors.map((e) => e.error).join(", "))
    }

    if (output) {
      if (isJson) {
        yield* writeOutputFile(output, JSON.stringify({ deleted, notFound }, null, 2), "delete result")
      } else {
        const lines = [
          ...deleted.map((id) => `Session ${id} deleted`),
          ...notFound.map((id) => `Session ${id} not found`),
        ]
        yield* writeOutputFile(output, lines.join(EOL) + (lines.length > 0 ? EOL : ""), "delete result")
      }
      return
    }

    if (isJson) {
      process.stdout.write(JSON.stringify({ deleted, notFound }, null, 2) + "\n")
      return
    }

    for (const id of deleted) {
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Session ${id} deleted` + UI.Style.TEXT_NORMAL)
    }
  }),
})

export const SessionRenameCommand = effectCmd({
  command: "rename <sessionID> <title>",
  describe: "rename a session",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        describe: "session ID to rename",
        type: "string",
        demandOption: true,
      })
      .positional("title", {
        describe: "new title for the session",
        type: "string",
        demandOption: true,
      })
      .option("output", {
        alias: "o",
        describe: "write rename result to output file path",
        type: "string",
      })
      .option("json", {
        describe: "output JSON",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.session.rename")(function* (args: {
    sessionID: string
    title: string
    output?: string
    o?: string
    json?: boolean
  }) {
    const output = args.output ?? (args as any).o
    const isJson = Boolean(args.json)
    const sdk = yield* localSdk()
    const result = yield* Effect.promise(async () => {
      return sdk.session.update({
        sessionID: args.sessionID,
        title: args.title,
      })
    })
    if (result.error) {
      return yield* fail(
        (result.error as { message?: string } | undefined)?.message ?? `Session not found: ${args.sessionID}`,
      )
    }
    const jsonStr = JSON.stringify({ id: args.sessionID, title: args.title }, null, 2)
    if (output) {
      if (isJson) {
        yield* writeOutputFile(output, jsonStr, "session rename")
      } else {
        yield* writeOutputFile(
          output,
          `Session ${args.sessionID} renamed to "${args.title}"` + EOL,
          "session rename",
        )
      }
      return
    }
    if (isJson) {
      console.log(jsonStr)
    } else {
      UI.println(
        UI.Style.TEXT_SUCCESS_BOLD + `Session ${args.sessionID} renamed to "${args.title}"` + UI.Style.TEXT_NORMAL,
      )
    }
  }),
})

export const SessionForkCommand = effectCmd({
  command: "fork <sessionID>",
  describe: "fork a session",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        describe: "session ID to fork",
        type: "string",
        demandOption: true,
      })
      .option("title", {
        alias: "t",
        describe: "custom title for the forked session",
        type: "string",
      })
      .option("message", {
        alias: "m",
        describe: "message ID up to which to fork",
        type: "string",
      })
      .option("output", {
        alias: "o",
        describe: "write forked session details to output file path",
        type: "string",
      })
      .option("json", {
        describe: "output JSON",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.session.fork")(function* (args: {
    sessionID: string
    title?: string
    t?: string
    message?: string
    m?: string
    output?: string
    o?: string
    json?: boolean
  }) {
    const title = args.title ?? (args as any).t
    const message = args.message ?? (args as any).m
    const output = args.output ?? (args as any).o
    const isJson = Boolean(args.json)
    const sdk = yield* localSdk()
    const result = yield* Effect.promise(async () => {
      return sdk.session.fork({
        sessionID: args.sessionID,
        messageID: message,
      })
    })
    if (result.error || !result.data) {
      return yield* fail(
        (result.error as { message?: string } | undefined)?.message ?? `Session not found: ${args.sessionID}`,
      )
    }

    if (title) {
      const updateRes = yield* Effect.promise(async () => {
        return sdk.session.update({
          sessionID: result.data.id,
          title: title!,
        })
      })
      if (!updateRes.error && updateRes.data) {
        result.data = updateRes.data
      } else if (!updateRes.error) {
        result.data.title = title
      }
    }

    const jsonStr = JSON.stringify(result.data, null, 2)
    if (output) {
      if (isJson) {
        yield* writeOutputFile(output, jsonStr, "forked session")
      } else {
        yield* writeOutputFile(
          output,
          `Forked session ${args.sessionID} to ${result.data.id}` + EOL,
          "forked session",
        )
      }
      return
    }

    if (isJson) {
      console.log(jsonStr)
    } else {
      UI.println(
        UI.Style.TEXT_SUCCESS_BOLD + `Forked session ${args.sessionID} to ${result.data.id}` + UI.Style.TEXT_NORMAL,
      )
    }
  }),
})

export const SessionShareCommand = effectCmd({
  command: "share <sessionID>",
  describe: "share a session (create a public share link)",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        describe: "session ID to share",
        type: "string",
        demandOption: true,
      })
      .option("unshare", {
        describe: "remove shared link",
        type: "boolean",
      })
      .option("output", {
        alias: "o",
        describe: "write share result to output file path",
        type: "string",
      })
      .option("json", {
        describe: "output JSON",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.session.share")(function* (args: {
    sessionID: string
    unshare?: boolean
    output?: string
    o?: string
    json?: boolean
  }) {
    const output = args.output ?? (args as any).o
    const isJson = Boolean(args.json)
    const sdk = yield* localSdk()
    if (args.unshare) {
      const result = yield* Effect.promise(async () => {
        return sdk.session.unshare({
          sessionID: args.sessionID,
        })
      })
      if (result.error) {
        return yield* fail(
          (result.error as { message?: string } | undefined)?.message ?? `Session not found: ${args.sessionID}`,
        )
      }
      const jsonStr = JSON.stringify({ id: args.sessionID, shared: false }, null, 2)
      if (output) {
        if (isJson) {
          yield* writeOutputFile(output, jsonStr, "share result")
        } else {
          yield* writeOutputFile(output, `Session ${args.sessionID} unshared` + EOL, "share result")
        }
        return
      }
      if (isJson) {
        console.log(jsonStr)
      } else {
        UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Session ${args.sessionID} unshared` + UI.Style.TEXT_NORMAL)
      }
      return
    }

    const result = yield* Effect.promise(async () => {
      return sdk.session.share({
        sessionID: args.sessionID,
      })
    })
    if (result.error || !result.data) {
      return yield* fail(
        (result.error as { message?: string } | undefined)?.message ?? `Session not found: ${args.sessionID}`,
      )
    }
    const shareUrl = result.data.share?.url
    const jsonStr = JSON.stringify({ id: args.sessionID, url: shareUrl, shared: true }, null, 2)
    if (output) {
      if (isJson) {
        yield* writeOutputFile(output, jsonStr, "share result")
      } else {
        yield* writeOutputFile(
          output,
          `Session ${args.sessionID} shared` + (shareUrl ? `: ${shareUrl}` : "") + EOL,
          "share result",
        )
      }
      return
    }
    if (isJson) {
      console.log(jsonStr)
    } else {
      UI.println(
        UI.Style.TEXT_SUCCESS_BOLD +
          `Session ${args.sessionID} shared` +
          (shareUrl ? `: ${shareUrl}` : "") +
          UI.Style.TEXT_NORMAL,
      )
    }
  }),
})

export const SessionUnshareCommand = effectCmd({
  command: "unshare <sessionID>",
  describe: "unshare a session (revoke public share link)",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        describe: "session ID to unshare",
        type: "string",
        demandOption: true,
      })
      .option("output", {
        alias: "o",
        describe: "write unshare result to output file path",
        type: "string",
      })
      .option("json", {
        describe: "output JSON",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.session.unshare")(function* (args: {
    sessionID: string
    output?: string
    o?: string
    json?: boolean
  }) {
    const output = args.output ?? (args as any).o
    const isJson = Boolean(args.json)
    const sdk = yield* localSdk()
    const result = yield* Effect.promise(async () => {
      return sdk.session.unshare({
        sessionID: args.sessionID,
      })
    })
    if (result.error) {
      return yield* fail(
        (result.error as { message?: string } | undefined)?.message ?? `Session not found: ${args.sessionID}`,
      )
    }
    const jsonStr = JSON.stringify({ id: args.sessionID, shared: false }, null, 2)
    if (output) {
      if (isJson) {
        yield* writeOutputFile(output, jsonStr, "unshare result")
      } else {
        yield* writeOutputFile(output, `Session ${args.sessionID} unshared` + EOL, "unshare result")
      }
      return
    }
    if (isJson) {
      console.log(jsonStr)
    } else {
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Session ${args.sessionID} unshared` + UI.Style.TEXT_NORMAL)
    }
  }),
})

export const SessionCompactCommand = effectCmd({
  command: "compact <sessionID>",
  aliases: ["summarize"],
  describe: "compact/summarize a session",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        describe: "session ID to compact",
        type: "string",
        demandOption: true,
      })
      .option("model", {
        alias: "m",
        describe: "model to use for compaction (provider/model)",
        type: "string",
      })
      .option("auto", {
        describe: "mark as auto-compaction",
        type: "boolean",
        default: false,
      })
      .option("output", {
        alias: "o",
        describe: "write compaction summary to output file path",
        type: "string",
      })
      .option("json", {
        describe: "output JSON",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.session.compact")(function* (args: {
    sessionID: string
    model?: string
    auto: boolean
    output?: string
    json?: boolean
  }) {
    const sdk = yield* localSdk()
    const sessionRes = yield* Effect.promise(async () => {
      return sdk.session.get({
        sessionID: args.sessionID,
      })
    })
    if (sessionRes.error || !sessionRes.data) {
      return yield* fail(
        (sessionRes.error as { message?: string } | undefined)?.message ?? `Session not found: ${args.sessionID}`,
      )
    }
    const sessionInfo = sessionRes.data

    const providerSvc = yield* Provider.Service
    let model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    if (args.model) {
      model = Provider.parseModel(args.model)
    } else if (sessionInfo.model) {
      model = {
        providerID: ProviderV2.ID.make(sessionInfo.model.providerID),
        modelID: ModelV2.ID.make(sessionInfo.model.id),
      }
    } else {
      model = yield* providerSvc
        .defaultModel()
        .pipe(Effect.mapError(() => new CliError({ message: "Could not determine model for compaction" })))
    }

    const result = yield* Effect.promise(async () => {
      return sdk.session.summarize({
        sessionID: args.sessionID,
        providerID: model.providerID,
        modelID: model.modelID,
        auto: args.auto,
      })
    })

    if (result.error) {
      return yield* fail(`Compaction failed: ${JSON.stringify(result.error)}`)
    }

    const jsonStr = JSON.stringify({ id: args.sessionID, compacted: true }, null, 2)
    if (args.output) {
      if (args.json) {
        yield* writeOutputFile(args.output, jsonStr, "compaction summary")
      } else {
        yield* writeOutputFile(args.output, `Session ${args.sessionID} compacted` + EOL, "compaction summary")
      }
      return
    }

    if (args.json) {
      console.log(jsonStr)
    } else {
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Session ${args.sessionID} compacted` + UI.Style.TEXT_NORMAL)
    }
  }),
})

export const SessionJobsCommand = effectCmd({
  command: "jobs <sessionID>",
  describe: "inspect background jobs for a session",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        describe: "session ID to inspect",
        type: "string",
        demandOption: true,
      })
      .option("output", {
        alias: "o",
        describe: "print output for a specific job ID",
        type: "string",
      })
      .option("job", {
        alias: "j",
        describe: "specific job ID to inspect",
        type: "string",
      })
      .option("status", {
        alias: "s",
        describe: "filter jobs by status",
        type: "string",
      })
      .option("file", {
        describe: "write jobs listing or output to file path",
        type: "string",
      })
      .option("json", {
        describe: "output JSON",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.session.jobs")(function* (args: {
    sessionID: string
    output?: string
    job?: string
    status?: string
    file?: string
    json?: boolean
  }) {
    const sdk = yield* localSdk()
    const sessionRes = yield* Effect.promise(async () => {
      return sdk.session.get({ sessionID: args.sessionID })
    })
    if (sessionRes.error || !sessionRes.data) {
      return yield* fail(
        (sessionRes.error as { message?: string } | undefined)?.message ?? `Session not found: ${args.sessionID}`,
      )
    }

    if (args.output) {
      const result = yield* Effect.promise(async () => {
        return sdk.session.job2.output({
          sessionID: args.sessionID,
          jobID: args.output!,
        })
      })
      if (result.error || !result.data) {
        const msg = (result.error as { message?: string } | undefined)?.message ?? `Job not found: ${args.output}`
        return yield* fail(msg)
      }
      if (args.file) {
        if (args.json) {
          yield* writeOutputFile(args.file, JSON.stringify(result.data, null, 2), "job output")
        } else {
          let text = ""
          if (result.data.untrustedOutput) {
            text = result.data.untrustedOutput.endsWith(EOL)
              ? result.data.untrustedOutput
              : result.data.untrustedOutput + EOL
          } else if (result.data.outputExpired) {
            text = `Job ${args.output} output has expired` + EOL
          } else {
            text = `Job ${args.output} has no output` + EOL
          }
          yield* writeOutputFile(args.file, text, "job output")
        }
        return
      }
      if (args.json) {
        console.log(JSON.stringify(result.data, null, 2))
      } else {
        if (result.data.untrustedOutput) {
          process.stdout.write(
            result.data.untrustedOutput.endsWith("\n")
              ? result.data.untrustedOutput
              : result.data.untrustedOutput + "\n",
          )
        } else if (result.data.outputExpired) {
          console.log(`Job ${args.output} output has expired`)
        } else {
          console.log(`Job ${args.output} has no output`)
        }
      }
      return
    }

    if (args.job) {
      const result = yield* Effect.promise(async () => {
        return sdk.session.job({
          sessionID: args.sessionID,
          jobID: args.job!,
        })
      })
      if (result.error || !result.data) {
        const msg = (result.error as { message?: string } | undefined)?.message ?? `Job not found: ${args.job}`
        return yield* fail(msg)
      }
      if (args.file) {
        if (args.json) {
          yield* writeOutputFile(args.file, JSON.stringify(result.data, null, 2), "job details")
        } else {
          yield* writeOutputFile(args.file, formatJobDetail(result.data) + EOL, "job details")
        }
        return
      }
      if (args.json) {
        console.log(JSON.stringify(result.data, null, 2))
      } else {
        console.log(formatJobDetail(result.data))
      }
      return
    }

    const result = yield* Effect.promise(async () => {
      return sdk.session.jobs({ sessionID: args.sessionID })
    })
    if (result.error || !result.data) {
      const msg = (result.error as { message?: string } | undefined)?.message ?? `Session not found: ${args.sessionID}`
      return yield* fail(msg)
    }

    let jobs = result.data
    if (args.status) {
      jobs = jobs.filter((j) => j.status === args.status)
    }

    if (args.file) {
      if (args.json) {
        yield* writeOutputFile(args.file, JSON.stringify(jobs, null, 2), "jobs")
      } else {
        if (jobs.length === 0) {
          const emptyMsg = args.status
            ? `No background jobs found with status "${args.status}" for session ${args.sessionID}`
            : `No background jobs found for session ${args.sessionID}`
          yield* writeOutputFile(args.file, emptyMsg + EOL, "jobs")
        } else {
          yield* writeOutputFile(args.file, formatJobsTable(jobs) + EOL, "jobs")
        }
      }
      return
    }

    if (args.json) {
      console.log(JSON.stringify(jobs, null, 2))
    } else {
      if (jobs.length === 0) {
        if (args.status) {
          console.log(`No background jobs found with status "${args.status}" for session ${args.sessionID}`)
        } else {
          console.log(`No background jobs found for session ${args.sessionID}`)
        }
        return
      }
      console.log(formatJobsTable(jobs))
    }
  }),
})

export const SessionCronsCommand = effectCmd({
  command: "crons <sessionID>",
  describe: "inspect scheduled cron jobs for a session",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        describe: "session ID to inspect",
        type: "string",
        demandOption: true,
      })
      .option("cron", {
        alias: "c",
        describe: "specific cron ID to inspect",
        type: "string",
      })
      .option("delete", {
        alias: "d",
        describe: "cron ID to delete/cancel",
        type: "string",
      })
      .option("output", {
        alias: "o",
        describe: "write crons report to output file path",
        type: "string",
      })
      .option("json", {
        describe: "output JSON",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.session.crons")(function* (args: {
    sessionID: string
    cron?: string
    delete?: string
    output?: string
    json?: boolean
  }) {
    const sessionSvc = yield* Session.Service
    yield* sessionSvc
      .get(args.sessionID as SessionID)
      .pipe(Effect.mapError(() => new CliError({ message: `Session not found: ${args.sessionID}` })))

    const cronRuntime = yield* SessionCronRuntime.Service

    if (args.delete) {
      const removed = yield* cronRuntime
        .remove(args.sessionID as SessionID, args.delete)
        .pipe(
          Effect.mapError(
            (err) => new CliError({ message: (err as Error).message ?? `Cron not found: ${args.delete}` }),
          ),
        )

      if (args.json) {
        const jsonStr = JSON.stringify(removed, null, 2) + EOL
        if (args.output) {
          yield* writeOutputFile(args.output, jsonStr, "cron deletion")
          return
        }
        process.stdout.write(jsonStr)
      } else {
        if (args.output) {
          yield* writeOutputFile(args.output, `Cron ${args.delete} deleted` + EOL, "cron deletion")
        }
        UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Cron ${args.delete} deleted` + UI.Style.TEXT_NORMAL)
      }
      return
    }

    const crons = yield* cronRuntime.list(args.sessionID as SessionID)

    if (args.cron) {
      const target = crons.find((c) => c.id === args.cron)
      if (!target) {
        return yield* fail(`Cron not found: ${args.cron}`)
      }
      if (args.json) {
        const jsonStr = JSON.stringify(target, null, 2) + EOL
        if (args.output) {
          yield* writeOutputFile(args.output, jsonStr, "cron details")
          return
        }
        process.stdout.write(jsonStr)
      } else {
        const text = formatCronDetail(target)
        if (args.output) {
          yield* writeOutputFile(args.output, text + EOL, "cron details")
          return
        }
        console.log(text)
      }
      return
    }

    if (args.json) {
      const jsonStr = JSON.stringify(crons, null, 2) + EOL
      if (args.output) {
        yield* writeOutputFile(args.output, jsonStr, "cron jobs")
        return
      }
      process.stdout.write(jsonStr)
    } else {
      if (crons.length === 0) {
        const text = `No scheduled cron jobs found for session ${args.sessionID}`
        if (args.output) {
          yield* writeOutputFile(args.output, text + EOL, "cron jobs")
          return
        }
        console.log(text)
        return
      }
      const text = formatCronsTable(crons)
      if (args.output) {
        yield* writeOutputFile(args.output, text + EOL, "cron jobs")
        return
      }
      console.log(text)
    }
  }),
})

export const SessionTodoCommand = effectCmd({
  command: "todo <sessionID>",
  describe: "list todo tasks for a session",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        describe: "session ID to inspect",
        type: "string",
        demandOption: true,
      })
      .option("status", {
        alias: "s",
        describe: "filter todos by status",
        type: "string",
      })
      .option("priority", {
        alias: "p",
        describe: "filter todos by priority",
        type: "string",
      })
      .option("search", {
        alias: ["q", "query"],
        describe: "search todos matching text query",
        type: "string",
      })
      .option("output", {
        alias: "o",
        describe: "write todos to output file path",
        type: "string",
      })
      .option("json", {
        describe: "output JSON",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.session.todo")(function* (args: {
    sessionID: string
    status?: string
    priority?: string
    search?: string
    output?: string
    json?: boolean
  }) {
    const sdk = yield* localSdk()
    const sessionRes = yield* Effect.promise(async () => {
      return sdk.session.get({ sessionID: args.sessionID })
    })
    if (sessionRes.error || !sessionRes.data) {
      return yield* fail(
        (sessionRes.error as { message?: string } | undefined)?.message ?? `Session not found: ${args.sessionID}`,
      )
    }

    const result = yield* Effect.promise(async () => {
      return sdk.session.todo({ sessionID: args.sessionID })
    })
    if (result.error || !result.data) {
      return yield* fail(
        (result.error as { message?: string } | undefined)?.message ??
          `Failed to retrieve todos for session: ${args.sessionID}`,
      )
    }

    let todos = (result.data ?? []) as SessionTodoItem[]

    if (args.status) {
      const statusFilter = args.status.toLowerCase()
      todos = todos.filter((t) => t.status && t.status.toLowerCase() === statusFilter)
    }

    if (args.priority) {
      const priorityFilter = args.priority.toLowerCase()
      todos = todos.filter((t) => t.priority && t.priority.toLowerCase() === priorityFilter)
    }

    if (args.search) {
      const query = args.search.toLowerCase()
      todos = todos.filter((t) => t.content && t.content.toLowerCase().includes(query))
    }

    if (args.json) {
      const jsonOutput = JSON.stringify(todos, null, 2)
      if (args.output) {
        const resolved = path.resolve(args.output)
        yield* Effect.promise(async () => {
          const fs = await import("fs/promises")
          await fs.mkdir(path.dirname(resolved), { recursive: true })
          await fs.writeFile(resolved, jsonOutput + EOL, "utf-8")
        })
        console.log(JSON.stringify({ ok: true, file: resolved, count: todos.length }, null, 2))
        return
      }
      console.log(jsonOutput)
      return
    }

    const hasFilter = Boolean(args.status || args.priority || args.search)
    const outputText = formatSessionTodos(args.sessionID, todos, hasFilter)

    if (args.output) {
      const resolved = path.resolve(args.output)
      yield* Effect.promise(async () => {
        const fs = await import("fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        await fs.writeFile(resolved, outputText + EOL, "utf-8")
      })
      UI.println(`Wrote ${todos.length} todo(s) to ${resolved}`)
      return
    }

    console.log(outputText)
  }),
})

export const SessionDiffCommand = effectCmd({
  command: "diff <sessionID>",
  describe: "show file diffs for a session",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        describe: "session ID to inspect",
        type: "string",
        demandOption: true,
      })
      .option("file", {
        alias: "path",
        describe: "filter diffs by file path",
        type: "string",
      })
      .option("output", {
        alias: "o",
        describe: "write diff to output file path",
        type: "string",
      })
      .option("message", {
        alias: "m",
        describe: "message ID to diff",
        type: "string",
      })
      .option("stat", {
        describe: "show diffstat summary only",
        type: "boolean",
      })
      .option("json", {
        describe: "output JSON",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.session.diff")(function* (args: {
    sessionID: string
    file?: string
    output?: string
    message?: string
    stat?: boolean
    json?: boolean
  }) {
    const sdk = yield* localSdk()
    const sessionRes = yield* Effect.promise(async () => {
      return sdk.session.get({ sessionID: args.sessionID })
    })
    if (sessionRes.error || !sessionRes.data) {
      return yield* fail(
        (sessionRes.error as { message?: string } | undefined)?.message ?? `Session not found: ${args.sessionID}`,
      )
    }

    const result = yield* Effect.promise(async () => {
      return sdk.session.diff({
        sessionID: args.sessionID,
        messageID: args.message,
      })
    })
    if (result.error || !result.data) {
      return yield* fail(
        (result.error as { message?: string } | undefined)?.message ??
          `Failed to retrieve diff for session: ${args.sessionID}`,
      )
    }

    let diffs = result.data as SessionFileDiff[]
    if (args.file) {
      const query = args.file.toLowerCase()
      diffs = diffs.filter(
        (d) => d.file && (d.file.toLowerCase().includes(query) || path.basename(d.file).toLowerCase() === query),
      )
    }

    if (args.json) {
      const jsonOutput = JSON.stringify(diffs, null, 2)
      if (args.output) {
        const resolved = path.resolve(args.output)
        yield* Effect.promise(async () => {
          const fs = await import("fs/promises")
          await fs.mkdir(path.dirname(resolved), { recursive: true })
          await fs.writeFile(resolved, jsonOutput + EOL, "utf-8")
        })
        console.log(JSON.stringify({ ok: true, file: resolved, count: diffs.length }, null, 2))
        return
      }
      console.log(jsonOutput)
      return
    }

    const outputText = args.stat
      ? formatSessionDiffStat(args.sessionID, diffs)
      : formatSessionDiff(args.sessionID, diffs)

    if (args.output) {
      const resolved = path.resolve(args.output)
      yield* Effect.promise(async () => {
        const fs = await import("fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        await fs.writeFile(resolved, outputText + EOL, "utf-8")
      })
      UI.println(`Wrote diff for ${diffs.length} file(s) to ${resolved}`)
      return
    }

    console.log(outputText)
  }),
})

export type SessionMemoryArgs = {
  sessionID: string
  output?: string
  json?: boolean
  write?: string
  append?: string
  file?: string
  clear?: boolean
}

export const sessionMemory = Effect.fn("Cli.session.memory")(function* (args: SessionMemoryArgs) {
  const toCliError = (err: unknown) => new CliError({ message: err instanceof Error ? err.message : String(err) })
  const session = yield* Session.Service.use((svc) => svc.get(SessionID.make(args.sessionID))).pipe(
    Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)),
    Effect.mapError(toCliError),
  )
  if (!session) {
    return yield* fail(`Session not found: ${args.sessionID}`)
  }

  const mutatingOptions = [args.write !== undefined, args.append !== undefined, args.file !== undefined, Boolean(args.clear)].filter(
    Boolean,
  )
  if (mutatingOptions.length > 1) {
    return yield* fail("Cannot specify more than one of --write, --append, --file, --clear")
  }

  const fsUtil = yield* FSUtil.Service
  const memoryPath = SessionDurableMemory.indexPath(args.sessionID)
  const readMemory = (id: string) => SessionDurableMemory.read(id).pipe(Effect.mapError(toCliError))
  const writeMemory = (id: string, text: string) => SessionDurableMemory.write(id, text).pipe(Effect.mapError(toCliError))

  // 1. Clear mode
  if (args.clear) {
    yield* writeMemory(args.sessionID, "")
    if (args.json) {
      process.stdout.write(
        JSON.stringify(
          {
            sessionID: args.sessionID,
            path: memoryPath,
            action: "clear",
            bytes: 0,
            success: true,
          },
          null,
          2,
        ) + EOL,
      )
      return
    }
    console.log(`Durable memory cleared for session ${args.sessionID}`)
    return
  }

  // 2. File write mode
  if (args.file) {
    const fileContent = yield* fsUtil.readFileStringSafe(args.file).pipe(Effect.mapError(toCliError))
    if (fileContent === undefined) {
      return yield* fail(`Failed to read file: ${args.file}`)
    }
    yield* writeMemory(args.sessionID, fileContent)
    const bytes = Buffer.byteLength(fileContent, "utf-8")
    if (args.json) {
      process.stdout.write(
        JSON.stringify(
          {
            sessionID: args.sessionID,
            path: memoryPath,
            action: "write",
            bytes,
            success: true,
          },
          null,
          2,
        ) + EOL,
      )
      return
    }
    console.log(`Durable memory updated for session ${args.sessionID} (${bytes} bytes from ${args.file})`)
    return
  }

  // 3. Direct write mode
  if (args.write !== undefined) {
    yield* writeMemory(args.sessionID, args.write)
    const bytes = Buffer.byteLength(args.write, "utf-8")
    if (args.json) {
      process.stdout.write(
        JSON.stringify(
          {
            sessionID: args.sessionID,
            path: memoryPath,
            action: "write",
            bytes,
            success: true,
          },
          null,
          2,
        ) + EOL,
      )
      return
    }
    console.log(`Durable memory updated for session ${args.sessionID} (${bytes} bytes)`)
    return
  }

  // 4. Append mode
  if (args.append !== undefined) {
    if (!args.append.trim()) {
      return yield* fail("Durable memory append requires non-empty content")
    }
    const prior = (yield* readMemory(args.sessionID)) ?? ""
    const updated = prior.trim() ? `${prior.trim()}\n\n${args.append.trim()}` : args.append.trim()
    yield* writeMemory(args.sessionID, updated)
    const bytes = Buffer.byteLength(updated, "utf-8")
    if (args.json) {
      process.stdout.write(
        JSON.stringify(
          {
            sessionID: args.sessionID,
            path: memoryPath,
            action: "append",
            bytes,
            success: true,
          },
          null,
          2,
        ) + EOL,
      )
      return
    }
    console.log(`Durable memory appended for session ${args.sessionID} (${bytes} bytes total)`)
    return
  }

  // 5. Read mode (default)
  const content = (yield* readMemory(args.sessionID)) ?? ""
  const bytes = Buffer.byteLength(content, "utf-8")
  const exists = Boolean(content.trim())

  if (args.output) {
    const resolved = path.resolve(args.output)
    yield* Effect.promise(async () => {
      const fs = await import("fs/promises")
      await fs.mkdir(path.dirname(resolved), { recursive: true })
      if (args.json) {
        await fs.writeFile(
          resolved,
          JSON.stringify({ sessionID: args.sessionID, path: memoryPath, exists, bytes, content }, null, 2) + EOL,
          "utf-8",
        )
      } else {
        await fs.writeFile(resolved, content.endsWith("\n") ? content : content + EOL, "utf-8")
      }
    })
    if (args.json) {
      process.stdout.write(JSON.stringify({ ok: true, file: resolved, bytes }, null, 2) + EOL)
    } else {
      UI.println(`Wrote durable memory (${bytes} bytes) to ${resolved}`)
    }
    return
  }

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          sessionID: args.sessionID,
          path: memoryPath,
          exists,
          bytes,
          content,
        },
        null,
        2,
      ) + EOL,
    )
    return
  }

  if (!exists) {
    console.log(`(no durable memory recorded for session ${args.sessionID})`)
    return
  }

  process.stdout.write(content.endsWith("\n") ? content : content + EOL)
})

export const SessionMemoryCommand = effectCmd({
  command: "memory <sessionID>",
  aliases: ["brain"],
  describe: "view or update durable memory for a session",
  builder: (yargs: Argv) =>
    yargs
      .positional("sessionID", {
        describe: "session ID to inspect or update",
        type: "string",
        demandOption: true,
      })
      .option("output", {
        alias: "o",
        describe: "write durable memory to output file path",
        type: "string",
      })
      .option("json", {
        describe: "output JSON",
        type: "boolean",
      })
      .option("write", {
        describe: "replace durable memory with markdown text",
        type: "string",
      })
      .option("append", {
        describe: "append markdown text to durable memory",
        type: "string",
      })
      .option("file", {
        describe: "replace durable memory with content from a file",
        type: "string",
      })
      .option("clear", {
        describe: "clear/wipe durable memory for the session",
        type: "boolean",
      }),
  handler: sessionMemory,
})

export const SessionExportCommand = ExportCommand
export const SessionImportCommand = ImportCommand

export const SessionListCommand = effectCmd({
  command: "list",
  describe: "list sessions",
  builder: (yargs) =>
    yargs
      .option("max-count", {
        alias: ["n", "limit"],
        describe: "limit to N most recent sessions",
        type: "number",
      })
      .option("roots", {
        describe: "only show root sessions",
        type: "boolean",
        default: true,
      })
      .option("all", {
        alias: ["a"],
        describe: "show sessions across all projects (global)",
        type: "boolean",
      })
      .option("search", {
        alias: ["q"],
        describe: "filter sessions by title",
        type: "string",
      })
      .option("output", {
        alias: "o",
        describe: "write sessions list to output file path",
        type: "string",
      })
      .option("format", {
        describe: "output format",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.session.list")(function* (args: {
    maxCount?: number
    limit?: number
    roots?: boolean
    all?: boolean
    search?: string
    output?: string
    format?: string
  }) {
    const limit = args.maxCount ?? (args as any).limit
    const sessions = yield* Session.Service.use((svc) =>
      args.all
        ? svc.listGlobal({ roots: args.roots, search: args.search, limit })
        : svc.list({ roots: args.roots, search: args.search, limit }),
    )

    if (sessions.length === 0) {
      if (args.output) {
        yield* writeOutputFile(args.output, args.format === "json" ? "[]" + EOL : "", "sessions list")
        return
      }
      return
    }

    const output = args.format === "json" ? formatSessionJSON(sessions) : formatSessionTable(sessions)

    if (args.output) {
      yield* writeOutputFile(args.output, output.endsWith(EOL) ? output : output + EOL, "sessions list")
      return
    }

    const shouldPaginate = process.stdout.isTTY && !limit && args.format === "table"

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
    cost: session.cost ?? 0,
    tokens: session.tokens,
  }))
  return JSON.stringify(jsonData, null, 2)
}

export type JobInfo = SessionJobInfo

export function formatJobsTable(jobs: JobInfo[]): string {
  const lines: string[] = []
  const maxIdWidth = Math.max(16, ...jobs.map((j) => j.id.length))
  const maxStatusWidth = Math.max(10, ...jobs.map((j) => j.status.length))

  const header = `Job ID${" ".repeat(maxIdWidth - 6)}  Status${" ".repeat(maxStatusWidth - 6)}  Exit  Output     Duration  Created`
  lines.push(header)
  lines.push("─".repeat(header.length))
  for (const job of jobs) {
    const exitStr = (job.exitCode !== undefined ? String(job.exitCode) : "-").padEnd(4)
    const outputStr = formatBytes(job.outputBytes).padEnd(9)
    const durationStr = formatDuration(job).padEnd(8)
    const ts = parseTimestamp(job.time.started) ?? parseTimestamp(job.time.created) ?? Date.now()
    const timeStr = Locale.todayTimeOrDateTime(ts)
    const line = `${job.id.padEnd(maxIdWidth)}  ${job.status.padEnd(maxStatusWidth)}  ${exitStr}  ${outputStr}  ${durationStr}  ${timeStr}`
    lines.push(line)
  }
  return lines.join(EOL)
}

export function formatJobDetail(job: JobInfo): string {
  const lines: string[] = [
    `Job ID: ${job.id}`,
    `Session ID: ${job.sessionID}`,
    `Status: ${job.status}`,
    `Output size: ${formatBytes(job.outputBytes)} (${job.outputBytes} bytes)`,
    `Exit code: ${job.exitCode !== undefined ? job.exitCode : "-"}`,
  ]
  if (job.signal !== undefined) lines.push(`Signal: ${job.signal}`)
  if (job.errorCode !== undefined) lines.push(`Error code: ${job.errorCode}`)
  if (job.timeout !== undefined) lines.push(`Timeout: ${job.timeout}ms`)
  const createdTs = parseTimestamp(job.time.created)
  if (createdTs !== undefined) lines.push(`Created: ${Locale.todayTimeOrDateTime(createdTs)}`)
  const startedTs = parseTimestamp(job.time.started)
  if (startedTs !== undefined) lines.push(`Started: ${Locale.todayTimeOrDateTime(startedTs)}`)
  const completedTs = parseTimestamp(job.time.completed)
  if (completedTs !== undefined) lines.push(`Completed: ${Locale.todayTimeOrDateTime(completedTs)}`)
  return lines.join(EOL)
}

function parseTimestamp(val: number | string | undefined): number | undefined {
  if (val === undefined) return undefined
  const n = typeof val === "number" ? val : Number(val)
  return Number.isNaN(n) ? undefined : n
}

function formatBytes(bytes: number | string): string {
  const n = typeof bytes === "number" ? bytes : Number(bytes)
  if (Number.isNaN(n)) return "0 B"
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function formatDuration(job: JobInfo): string {
  const start = parseTimestamp(job.time.started)
  if (!start) return "-"
  const end = parseTimestamp(job.time.completed) ?? Date.now()
  const ms = Math.max(0, end - start)
  if (ms < 1000) return `${ms}ms`
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const remainingSec = sec % 60
  return `${min}m${remainingSec}s`
}

export type CronInfo = SessionCronRuntime.Info

export function formatCronsTable(crons: CronInfo[]): string {
  const lines: string[] = []
  const maxIdWidth = Math.max(16, ...crons.map((c) => c.id.length))
  const maxScheduleWidth = Math.max(12, ...crons.map((c) => c.cron.length))

  const header = `Cron ID${" ".repeat(maxIdWidth - 7)}  Schedule${" ".repeat(maxScheduleWidth - 8)}  Recurring  Last Fired  Expires     Prompt`
  lines.push(header)
  lines.push("─".repeat(header.length + 10))
  for (const cron of crons) {
    const recurringStr = (cron.recurring ? "yes" : "no").padEnd(9)
    const lastFiredStr = (cron.lastFiredAt ? Locale.todayTimeOrDateTime(cron.lastFiredAt) : "-").padEnd(10)
    const expiresStr = (cron.expiresAt ? Locale.todayTimeOrDateTime(cron.expiresAt) : "-").padEnd(10)
    const promptStr = Locale.truncate(cron.prompt.replace(/\s+/g, " "), 30)
    const line = `${cron.id.padEnd(maxIdWidth)}  ${cron.cron.padEnd(maxScheduleWidth)}  ${recurringStr}  ${lastFiredStr}  ${expiresStr}  ${promptStr}`
    lines.push(line)
  }
  return lines.join(EOL)
}

export function formatCronDetail(cron: CronInfo): string {
  const lines: string[] = [
    `Cron ID: ${cron.id}`,
    `Session ID: ${cron.sessionID}`,
    `Schedule: ${cron.cron}`,
    `Recurring: ${cron.recurring ? "yes" : "no"}`,
    `Prompt: ${cron.prompt}`,
    `Created: ${Locale.todayTimeOrDateTime(cron.createdAt)}`,
  ]
  if (cron.expiresAt !== undefined) lines.push(`Expires: ${Locale.todayTimeOrDateTime(cron.expiresAt)}`)
  lines.push(`Last fired: ${cron.lastFiredAt !== undefined ? Locale.todayTimeOrDateTime(cron.lastFiredAt) : "-"}`)
  return lines.join(EOL)
}

export type SessionTodoItem = {
  id?: string
  content: string
  status: string
  priority: string
}

export function formatSessionTodos(sessionID: string, todos: SessionTodoItem[], filtered = false): string {
  if (todos.length === 0) {
    return filtered
      ? `No todos matching filters found for session ${sessionID}`
      : `No todos found for session ${sessionID}`
  }
  const completed = todos.filter((t) => t.status === "completed").length
  const header = filtered
    ? `Todos for session ${sessionID} (${completed}/${todos.length} completed, filtered):`
    : `Todos for session ${sessionID} (${completed}/${todos.length} completed):`
  const lines = [header]
  for (const todo of todos) {
    const marker =
      todo.status === "completed"
        ? "[x]"
        : todo.status === "in_progress"
          ? "[>]"
          : todo.status === "cancelled"
            ? "[-]"
            : "[ ]"
    lines.push(`  ${marker} [${todo.priority}] ${todo.content}`)
  }
  return lines.join(EOL)
}

export type SessionFileDiff = {
  file?: string
  patch?: string
  additions: number
  deletions: number
  status?: string
}

export function formatSessionDiffStat(sessionID: string, diffs: SessionFileDiff[]): string {
  if (diffs.length === 0) {
    return `No diffs found for session ${sessionID}`
  }
  let totalAdd = 0
  let totalDel = 0
  const lines = [`Diffstat for session ${sessionID}:`]
  for (const d of diffs) {
    const file = d.file ?? "unknown"
    const add = d.additions ?? 0
    const del = d.deletions ?? 0
    totalAdd += add
    totalDel += del
    lines.push(`  ${file} | +${add} -${del}`)
  }
  lines.push(`${diffs.length} file(s) changed, ${totalAdd} insertions(+), ${totalDel} deletions(-)`)
  return lines.join(EOL)
}

export function formatSessionDiff(sessionID: string, diffs: SessionFileDiff[]): string {
  if (diffs.length === 0) {
    return `No diffs found for session ${sessionID}`
  }
  const lines: string[] = []
  for (const d of diffs) {
    const file = d.file ?? "unknown"
    const add = d.additions ?? 0
    const del = d.deletions ?? 0
    lines.push(`diff --git a/${file} b/${file} (+${add} -${del})`)
    if (d.patch) {
      lines.push(d.patch)
    }
  }
  return lines.join(EOL)
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
  options?: { session?: SessionInfo; pricing?: Pricing; jobs?: JobInfo[]; crons?: CronInfo[] },
) {
  const report = createSessionReport(sessionID, messages)

  // Tokens: prefer persisted session row totals; fall back to summed report tokens
  const sessionTokens = options?.session?.tokens
  const sessionSum = sessionTokens
    ? sessionTokens.input +
      sessionTokens.output +
      sessionTokens.reasoning +
      sessionTokens.cache.read +
      sessionTokens.cache.write
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

  // Cost: prefer persisted session row cost when present and > 0; fall back to tokens × pricing; 0 when pricing unavailable
  const persistedCost = options?.session?.cost
  const hasPersistedCost = typeof persistedCost === "number" && persistedCost > 0
  const pricing = options?.pricing
  let costUsd: number
  let costSource: "persisted" | "derived" | "unavailable"
  let pricingAvailable: boolean

  if (hasPersistedCost) {
    costUsd = persistedCost
    costSource = "persisted"
    pricingAvailable = true
  } else if (pricing) {
    costUsd =
      (tokens.input * pricing.input +
        tokens.output * pricing.output +
        tokens.reasoning * pricing.output +
        tokens.cache.read * pricing.cache.read +
        tokens.cache.write * pricing.cache.write) /
      1_000_000
    costSource = "derived"
    pricingAvailable = true
  } else {
    costUsd = 0
    costSource = "unavailable"
    pricingAvailable = false
  }

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

  const rawJobs = options?.jobs ?? []
  let jobsActive = 0
  let jobsCompleted = 0
  let jobsFailed = 0
  for (const job of rawJobs) {
    if (job.status === "queued" || job.status === "starting" || job.status === "running") {
      jobsActive++
    } else if (job.status === "completed") {
      jobsCompleted++
    } else {
      jobsFailed++
    }
  }
  const jobs = {
    total: rawJobs.length,
    active: jobsActive,
    completed: jobsCompleted,
    failed: jobsFailed,
  }

  const rawCrons = options?.crons ?? []
  let cronsRecurring = 0
  let cronsOneShot = 0
  for (const cron of rawCrons) {
    if (cron.recurring) {
      cronsRecurring++
    } else {
      cronsOneShot++
    }
  }
  const crons = {
    total: rawCrons.length,
    recurring: cronsRecurring,
    one_shot: cronsOneShot,
  }

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
      source: costSource,
      pricing_available: pricingAvailable,
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
    jobs,
    crons,
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
  if (metrics.jobs.total > 0) {
    lines.push(
      `Jobs: total ${metrics.jobs.total}, active ${metrics.jobs.active}, completed ${metrics.jobs.completed}, failed ${metrics.jobs.failed}`,
    )
  }
  if (metrics.crons.total > 0) {
    lines.push(
      `Crons: total ${metrics.crons.total}, recurring ${metrics.crons.recurring}, one_shot ${metrics.crons.one_shot}`,
    )
  }
  return lines.join(EOL)
}

export function createSessionHealth(
  sessionID: string,
  messages: SessionMessage[],
  providers?: Record<ProviderV2.ID, { models: Record<ModelV2.ID, { limit: { context?: number } }> }>,
) {
  const report = createSessionReport(sessionID, messages)
  const model = latestModel(messages)
  const contextLimit = model
    ? providers?.[ProviderV2.ID.make(model.providerID)]?.models[ModelV2.ID.make(model.modelID)]?.limit.context
    : undefined
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
  return [input, metadata]
    .flatMap((source) => fields.flatMap((field) => pathFromField(source, field)))
    .map((path) => ({
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
