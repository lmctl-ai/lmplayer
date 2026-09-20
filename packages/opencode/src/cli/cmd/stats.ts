import { Effect } from "effect"
import { effectCmd, fail } from "../effect-cmd"
import { Session } from "@/session/session"
import { NotFoundError } from "@/storage/storage"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Project } from "@/project/project"
import { InstanceRef } from "@/effect/instance-ref"
import { UI } from "../ui"
import path from "path"
import fs from "fs/promises"

export interface SessionStats {
  totalSessions: number
  totalMessages: number
  totalCost: number
  totalTokens: {
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
  }
  toolUsage: Record<string, number>
  modelUsage: Record<
    string,
    {
      messages: number
      tokens: {
        input: number
        output: number
        cache: {
          read: number
          write: number
        }
      }
      cost: number
    }
  >
  dateRange: {
    earliest: number
    latest: number
  }
  days: number
  costPerDay: number
  tokensPerSession: number
  medianTokensPerSession: number
}

export interface BudgetStats {
  limit: number
  used: number
  remaining: number
  percentage: number
  exceeded: boolean
}

export function computeBudgetStats(totalCost: number, budgetLimit: number): BudgetStats {
  const used = isNaN(totalCost) ? 0 : totalCost
  const remaining = Math.max(0, budgetLimit - used)
  const percentage = budgetLimit > 0 ? (used / budgetLimit) * 100 : 0
  const exceeded = budgetLimit > 0 ? used >= budgetLimit : used > 0
  return {
    limit: budgetLimit,
    used,
    remaining,
    percentage: Math.round(percentage * 100) / 100,
    exceeded,
  }
}

export type StatsJson = {
  total_sessions: number
  total_messages: number
  total_cost: number
  total_tokens: {
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
    total: number
  }
  averages: {
    cost_per_day: number
    tokens_per_session: number
    median_tokens_per_session: number
  }
  days: number
  date_range: {
    earliest: number
    latest: number
  }
  tool_usage: Record<string, number>
  model_usage: Record<
    string,
    {
      messages: number
      tokens: {
        input: number
        output: number
        cache: {
          read: number
          write: number
        }
        total: number
      }
      cost: number
    }
  >
  filters?: {
    days?: number
    project?: string
    provider?: string
    model?: string
  }
  budget?: BudgetStats
}

export function formatStatsJson(
  stats: SessionStats,
  toolLimit?: number,
  modelLimit?: number,
  filters?: {
    days?: number
    project?: string
    provider?: string
    model?: string
  },
  budget?: BudgetStats,
): StatsJson {
  const totalTokens =
    stats.totalTokens.input +
    stats.totalTokens.output +
    stats.totalTokens.reasoning +
    stats.totalTokens.cache.read +
    stats.totalTokens.cache.write

  let toolUsage = stats.toolUsage
  if (toolLimit !== undefined) {
    const sorted = Object.entries(stats.toolUsage).sort(([, a], [, b]) => b - a)
    toolUsage = Object.fromEntries(sorted.slice(0, toolLimit))
  }

  let modelUsageEntries = Object.entries(stats.modelUsage).map(([model, usage]) => {
    const modelTotalTokens =
      usage.tokens.input + usage.tokens.output + usage.tokens.cache.read + usage.tokens.cache.write
    return [
      model,
      {
        messages: usage.messages,
        tokens: {
          input: usage.tokens.input,
          output: usage.tokens.output,
          cache: {
            read: usage.tokens.cache.read,
            write: usage.tokens.cache.write,
          },
          total: modelTotalTokens,
        },
        cost: usage.cost,
      },
    ] as const
  })

  if (modelLimit !== undefined && modelLimit !== Infinity) {
    modelUsageEntries = modelUsageEntries
      .sort(([, a], [, b]) => b.messages - a.messages)
      .slice(0, modelLimit)
  }

  return {
    total_sessions: stats.totalSessions,
    total_messages: stats.totalMessages,
    total_cost: stats.totalCost,
    total_tokens: {
      input: stats.totalTokens.input,
      output: stats.totalTokens.output,
      reasoning: stats.totalTokens.reasoning,
      cache: {
        read: stats.totalTokens.cache.read,
        write: stats.totalTokens.cache.write,
      },
      total: totalTokens,
    },
    averages: {
      cost_per_day: stats.costPerDay,
      tokens_per_session: stats.tokensPerSession,
      median_tokens_per_session: stats.medianTokensPerSession,
    },
    days: stats.days,
    date_range: {
      earliest: stats.dateRange.earliest,
      latest: stats.dateRange.latest,
    },
    tool_usage: toolUsage,
    model_usage: Object.fromEntries(modelUsageEntries),
    ...(filters && Object.values(filters).some((v) => v !== undefined) ? { filters } : {}),
    ...(budget ? { budget } : {}),
  }
}

export const runStats = Effect.fn("Cli.stats.run")(function* (args: {
  days?: number
  tools?: number
  models?: boolean | number
  project?: string
  provider?: string
  model?: string
  budget?: number
  budgetCheck?: boolean
  json?: boolean
  output?: string
}) {
  if (args.budgetCheck && args.budget === undefined) {
    yield* fail("--budget-check requires --budget <amount> to be specified")
  }
  if (args.budget !== undefined && (isNaN(args.budget) || args.budget < 0)) {
    yield* fail("--budget must be a non-negative number")
  }
  const ctx = yield* InstanceRef
  if (!ctx) return
  const stats = yield* aggregateSessionStats(args.days, args.project, ctx.project, args.provider, args.model)
  let modelLimit: number | undefined
  if (args.models === true || ((args.provider || args.model) && args.models === undefined)) {
    modelLimit = Infinity
  } else if (typeof args.models === "number") {
    modelLimit = args.models
  }
  const budgetInfo = args.budget !== undefined ? computeBudgetStats(stats.totalCost, args.budget) : undefined
  if (args.json) {
    const out = formatStatsJson(
      stats,
      args.tools,
      modelLimit,
      {
        days: args.days,
        project: args.project,
        provider: args.provider,
        model: args.model,
      },
      budgetInfo,
    )
    const jsonStr = JSON.stringify(out, null, 2) + "\n"
    if (args.output) {
      const resolved = path.resolve(args.output)
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        await fs.writeFile(resolved, jsonStr, "utf-8")
      })
      UI.println(`Wrote statistics to ${resolved}`)
    } else {
      process.stdout.write(jsonStr)
    }
    if (args.budgetCheck && budgetInfo?.exceeded) {
      yield* fail(
        `Budget limit exceeded: spent $${budgetInfo.used.toFixed(2)} of $${budgetInfo.limit.toFixed(2)} budget (${budgetInfo.percentage.toFixed(1)}%)`,
        2,
      )
    }
    return out
  }
  if (args.output) {
    const text = renderStatsText(
      stats,
      args.tools,
      modelLimit,
      {
        days: args.days,
        project: args.project,
        provider: args.provider,
        model: args.model,
      },
      budgetInfo,
    )
    const resolved = path.resolve(args.output)
    yield* Effect.promise(async () => {
      await fs.mkdir(path.dirname(resolved), { recursive: true })
      await fs.writeFile(resolved, text, "utf-8")
    })
    UI.println(`Wrote statistics to ${resolved}`)
    if (args.budgetCheck && budgetInfo?.exceeded) {
      yield* fail(
        `Budget limit exceeded: spent $${budgetInfo.used.toFixed(2)} of $${budgetInfo.limit.toFixed(2)} budget (${budgetInfo.percentage.toFixed(1)}%)`,
        2,
      )
    }
    return stats
  }
  displayStats(
    stats,
    args.tools,
    modelLimit,
    {
      days: args.days,
      project: args.project,
      provider: args.provider,
      model: args.model,
    },
    budgetInfo,
  )
  if (args.budgetCheck && budgetInfo?.exceeded) {
    yield* fail(
      `Budget limit exceeded: spent $${budgetInfo.used.toFixed(2)} of $${budgetInfo.limit.toFixed(2)} budget (${budgetInfo.percentage.toFixed(1)}%)`,
      2,
    )
  }
  return stats
})

export const StatsCommand = effectCmd({
  command: "stats",
  describe: "show token usage and cost statistics",
  builder: (yargs) =>
    yargs
      .option("days", {
        describe: "show stats for the last N days (default: all time)",
        type: "number",
      })
      .option("tools", {
        describe: "number of tools to show (default: all)",
        type: "number",
      })
      .option("models", {
        describe: "show model statistics (default: hidden). Pass a number to show top N, otherwise shows all",
      })
      .option("project", {
        describe: "filter by project (default: all projects, empty string: current project)",
        type: "string",
      })
      .option("provider", {
        describe: "filter by provider ID (e.g. ollama-cloud, deepseek)",
        type: "string",
      })
      .option("model", {
        describe: "filter by model ID or provider/model (e.g. deepseek-v4.1-flash, kimi-k2.7-code)",
        type: "string",
      })
      .option("budget", {
        describe: "budget limit in USD to compare spend against (e.g. 10.00)",
        type: "number",
      })
      .option("budget-check", {
        describe: "exit with code 2 if total spend exceeds budget limit",
        type: "boolean",
      })
      .option("output", {
        alias: "o",
        describe: "write statistics to output file path",
        type: "string",
      })
      .option("json", {
        describe: "output as JSON",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.stats")(function* (args) {
    yield* runStats({
      days: args.days,
      tools: args.tools,
      models: args.models as boolean | number | undefined,
      project: args.project,
      provider: args.provider,
      model: args.model,
      budget: args.budget,
      budgetCheck: Boolean(args["budget-check"] ?? args.budgetCheck),
      json: Boolean(args.json),
      output: args.output,
    })
  }),
})

const getAllSessions = Effect.fnUntraced(function* () {
  const { db } = yield* Database.Service
  return (yield* db.select().from(SessionTable).all().pipe(Effect.orDie)).map((row) => Session.fromRow(row))
})

const aggregateSessionStats = Effect.fn("Cli.stats.aggregate")(function* (
  days?: number,
  projectFilter?: string,
  currentProject?: Project.Info,
  providerFilter?: string,
  modelFilter?: string,
) {
  const svc = yield* Session.Service
  const sessions = yield* getAllSessions()
  const MS_IN_DAY = 24 * 60 * 60 * 1000

  const cutoffTime = (() => {
    if (days === undefined) return 0
    if (days === 0) {
      const now = new Date()
      now.setHours(0, 0, 0, 0)
      return now.getTime()
    }
    return Date.now() - days * MS_IN_DAY
  })()

  const windowDays = (() => {
    if (days === undefined) return
    if (days === 0) return 1
    return days
  })()

  let filteredSessions = cutoffTime > 0 ? sessions.filter((session) => session.time.updated >= cutoffTime) : sessions

  if (projectFilter !== undefined) {
    if (projectFilter === "") {
      if (!currentProject) throw new Error("currentProject required when projectFilter is empty string")
      filteredSessions = filteredSessions.filter((session) => session.projectID === currentProject.id)
    } else {
      filteredSessions = filteredSessions.filter((session) => session.projectID === projectFilter)
    }
  }

  const isFiltered = Boolean(providerFilter || modelFilter)

  const stats: SessionStats = {
    totalSessions: 0,
    totalMessages: 0,
    totalCost: 0,
    totalTokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
    toolUsage: {},
    modelUsage: {},
    dateRange: {
      earliest: Date.now(),
      latest: Date.now(),
    },
    days: 0,
    costPerDay: 0,
    tokensPerSession: 0,
    medianTokensPerSession: 0,
  }

  if (filteredSessions.length > 1000) {
    console.log(`Large dataset detected (${filteredSessions.length} sessions). This may take a while...`)
  }

  if (filteredSessions.length === 0) {
    stats.days = windowDays ?? 0
    return stats
  }

  let earliestTime = Date.now()
  let latestTime = 0

  const sessionTotalTokens: number[] = []

  const rawResults = yield* Effect.forEach(
    filteredSessions,
    (session) =>
      Effect.gen(function* () {
        const messages = yield* svc
          .messages({ sessionID: session.id })
          .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed([])))

        const sessionCost = session.cost ?? 0
        const sessionTokens = session.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        let sessionToolUsage: Record<string, number> = {}
        let sessionModelUsage: Record<
          string,
          {
            messages: number
            tokens: { input: number; output: number; cache: { read: number; write: number } }
            cost: number
          }
        > = {}

        let filteredCost = 0
        let filteredTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        let matchingAssistantCount = 0

        for (const message of messages) {
          if (message.info.role === "assistant") {
            const providerID = message.info.providerID
            const modelID = message.info.modelID
            const modelKey = `${providerID}/${modelID}`

            if (providerFilter && providerID !== providerFilter) continue
            if (modelFilter && modelID !== modelFilter && modelKey !== modelFilter) continue

            matchingAssistantCount++
            const msgCost = message.info.cost || 0
            filteredCost += msgCost

            if (!sessionModelUsage[modelKey]) {
              sessionModelUsage[modelKey] = {
                messages: 0,
                tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
                cost: 0,
              }
            }
            sessionModelUsage[modelKey].messages++
            sessionModelUsage[modelKey].cost += msgCost

            if (message.info.tokens) {
              const input = message.info.tokens.input || 0
              const output = message.info.tokens.output || 0
              const reasoning = message.info.tokens.reasoning || 0
              const cacheRead = message.info.tokens.cache?.read || 0
              const cacheWrite = message.info.tokens.cache?.write || 0

              filteredTokens.input += input
              filteredTokens.output += output
              filteredTokens.reasoning += reasoning
              filteredTokens.cache.read += cacheRead
              filteredTokens.cache.write += cacheWrite

              sessionModelUsage[modelKey].tokens.input += input
              sessionModelUsage[modelKey].tokens.output += output + reasoning
              sessionModelUsage[modelKey].tokens.cache.read += cacheRead
              sessionModelUsage[modelKey].tokens.cache.write += cacheWrite
            }

            for (const part of message.parts) {
              if (part.type === "tool" && part.tool) {
                sessionToolUsage[part.tool] = (sessionToolUsage[part.tool] || 0) + 1
              }
            }
          } else if (!isFiltered) {
            for (const part of message.parts) {
              if (part.type === "tool" && part.tool) {
                sessionToolUsage[part.tool] = (sessionToolUsage[part.tool] || 0) + 1
              }
            }
          }
        }

        if (isFiltered && matchingAssistantCount === 0) {
          return null
        }

        const sessionSum =
          sessionTokens.input +
          sessionTokens.output +
          sessionTokens.reasoning +
          sessionTokens.cache.read +
          sessionTokens.cache.write
        const effectiveCost = isFiltered ? filteredCost : sessionCost > 0 ? sessionCost : filteredCost
        const effectiveTokens = isFiltered ? filteredTokens : sessionSum > 0 ? sessionTokens : filteredTokens
        const effectiveMessageCount = isFiltered ? matchingAssistantCount : messages.length

        return {
          messageCount: effectiveMessageCount,
          sessionCost: effectiveCost,
          sessionTokens: effectiveTokens,
          sessionTotalTokens:
            effectiveTokens.input +
            effectiveTokens.output +
            effectiveTokens.reasoning +
            effectiveTokens.cache.read +
            effectiveTokens.cache.write,
          sessionToolUsage,
          sessionModelUsage,
          earliestTime: cutoffTime > 0 ? session.time.updated : session.time.created,
          latestTime: session.time.updated,
        }
      }),
    { concurrency: 20 },
  )

  const results = rawResults.filter((r): r is NonNullable<typeof r> => r !== null)
  stats.totalSessions = results.length

  if (results.length === 0) {
    stats.days = windowDays ?? 0
    return stats
  }

  for (const result of results) {
    earliestTime = Math.min(earliestTime, result.earliestTime)
    latestTime = Math.max(latestTime, result.latestTime)
    sessionTotalTokens.push(result.sessionTotalTokens)

    stats.totalMessages += result.messageCount
    stats.totalCost += result.sessionCost
    stats.totalTokens.input += result.sessionTokens.input
    stats.totalTokens.output += result.sessionTokens.output
    stats.totalTokens.reasoning += result.sessionTokens.reasoning
    stats.totalTokens.cache.read += result.sessionTokens.cache.read
    stats.totalTokens.cache.write += result.sessionTokens.cache.write

    for (const [tool, count] of Object.entries(result.sessionToolUsage)) {
      stats.toolUsage[tool] = (stats.toolUsage[tool] || 0) + count
    }

    for (const [model, usage] of Object.entries(result.sessionModelUsage)) {
      if (!stats.modelUsage[model]) {
        stats.modelUsage[model] = {
          messages: 0,
          tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          cost: 0,
        }
      }
      stats.modelUsage[model].messages += usage.messages
      stats.modelUsage[model].tokens.input += usage.tokens.input
      stats.modelUsage[model].tokens.output += usage.tokens.output
      stats.modelUsage[model].tokens.cache.read += usage.tokens.cache.read
      stats.modelUsage[model].tokens.cache.write += usage.tokens.cache.write
      stats.modelUsage[model].cost += usage.cost
    }
  }

  const rangeDays = Math.max(1, Math.ceil((latestTime - earliestTime) / MS_IN_DAY))
  const effectiveDays = windowDays ?? rangeDays
  stats.dateRange = {
    earliest: earliestTime,
    latest: latestTime,
  }
  stats.days = effectiveDays
  stats.costPerDay = stats.totalCost / effectiveDays
  const totalTokens =
    stats.totalTokens.input +
    stats.totalTokens.output +
    stats.totalTokens.reasoning +
    stats.totalTokens.cache.read +
    stats.totalTokens.cache.write
  stats.tokensPerSession = filteredSessions.length > 0 ? totalTokens / filteredSessions.length : 0
  sessionTotalTokens.sort((a, b) => a - b)
  const mid = Math.floor(sessionTotalTokens.length / 2)
  stats.medianTokensPerSession =
    sessionTotalTokens.length === 0
      ? 0
      : sessionTotalTokens.length % 2 === 0
        ? (sessionTotalTokens[mid - 1] + sessionTotalTokens[mid]) / 2
        : sessionTotalTokens[mid]

  return stats
})

export function renderStatsLines(
  stats: SessionStats,
  toolLimit?: number,
  modelLimit?: number,
  filters?: {
    days?: number
    project?: string
    provider?: string
    model?: string
  },
  budget?: BudgetStats,
): string[] {
  const width = 56
  const lines: string[] = []

  function renderRow(label: string, value: string): string {
    const formattedLabel = label.startsWith(" ") ? label : ` ${label}`
    const availableWidth = width - 1
    const paddingNeeded = availableWidth - formattedLabel.length - value.length
    const padding = Math.max(0, paddingNeeded)
    return `│${formattedLabel}${" ".repeat(padding)}${value} │`
  }

  // Overview section
  lines.push("┌────────────────────────────────────────────────────────┐")
  lines.push("│                       OVERVIEW                         │")
  lines.push("├────────────────────────────────────────────────────────┤")
  lines.push(renderRow("Sessions", stats.totalSessions.toLocaleString()))
  lines.push(renderRow("Messages", stats.totalMessages.toLocaleString()))
  lines.push(renderRow("Days", stats.days.toString()))
  if (filters?.project !== undefined) {
    lines.push(renderRow("Project", filters.project === "" ? "(current)" : filters.project))
  }
  if (filters?.provider) {
    lines.push(renderRow("Provider", filters.provider))
  }
  if (filters?.model) {
    lines.push(renderRow("Model", filters.model))
  }
  lines.push("└────────────────────────────────────────────────────────┘")
  lines.push("")

  // Cost & Tokens section
  lines.push("┌────────────────────────────────────────────────────────┐")
  lines.push("│                    COST & TOKENS                       │")
  lines.push("├────────────────────────────────────────────────────────┤")
  const cost = isNaN(stats.totalCost) ? 0 : stats.totalCost
  const costPerDay = isNaN(stats.costPerDay) ? 0 : stats.costPerDay
  const tokensPerSession = isNaN(stats.tokensPerSession) ? 0 : stats.tokensPerSession
  lines.push(renderRow("Total Cost", `$${cost.toFixed(2)}`))
  lines.push(renderRow("Avg Cost/Day", `$${costPerDay.toFixed(2)}`))
  lines.push(renderRow("Avg Tokens/Session", formatNumber(Math.round(tokensPerSession))))
  const medianTokensPerSession = isNaN(stats.medianTokensPerSession) ? 0 : stats.medianTokensPerSession
  lines.push(renderRow("Median Tokens/Session", formatNumber(Math.round(medianTokensPerSession))))
  lines.push(renderRow("Input", formatNumber(stats.totalTokens.input)))
  lines.push(renderRow("Output", formatNumber(stats.totalTokens.output)))
  lines.push(renderRow("Cache Read", formatNumber(stats.totalTokens.cache.read)))
  lines.push(renderRow("Cache Write", formatNumber(stats.totalTokens.cache.write)))
  lines.push("└────────────────────────────────────────────────────────┘")
  lines.push("")

  // Budget section
  if (budget) {
    lines.push("┌────────────────────────────────────────────────────────┐")
    lines.push("│                         BUDGET                         │")
    lines.push("├────────────────────────────────────────────────────────┤")
    lines.push(renderRow("Budget Limit", `$${budget.limit.toFixed(2)}`))
    lines.push(renderRow("Total Spend", `$${budget.used.toFixed(2)}`))
    lines.push(renderRow("Remaining", `$${budget.remaining.toFixed(2)}`))
    lines.push(renderRow("Usage", `${budget.percentage.toFixed(2)}%`))
    lines.push(
      renderRow(
        "Status",
        budget.exceeded ? "EXCEEDED [ALERT]" : "WITHIN BUDGET",
      ),
    )
    lines.push("└────────────────────────────────────────────────────────┘")
    lines.push("")
  }

  // Model Usage section
  if (modelLimit !== undefined && Object.keys(stats.modelUsage).length > 0) {
    const sortedModels = Object.entries(stats.modelUsage).sort(([, a], [, b]) => b.messages - a.messages)
    const modelsToDisplay = modelLimit === Infinity ? sortedModels : sortedModels.slice(0, modelLimit)

    lines.push("┌────────────────────────────────────────────────────────┐")
    lines.push("│                      MODEL USAGE                       │")
    lines.push("├────────────────────────────────────────────────────────┤")

    for (let i = 0; i < modelsToDisplay.length; i++) {
      const [model, usage] = modelsToDisplay[i]
      lines.push(`│ ${model.padEnd(54)} │`)
      lines.push(renderRow("  Messages", usage.messages.toLocaleString()))
      lines.push(renderRow("  Input Tokens", formatNumber(usage.tokens.input)))
      lines.push(renderRow("  Output Tokens", formatNumber(usage.tokens.output)))
      lines.push(renderRow("  Cache Read", formatNumber(usage.tokens.cache.read)))
      lines.push(renderRow("  Cache Write", formatNumber(usage.tokens.cache.write)))
      lines.push(renderRow("  Cost", `$${usage.cost.toFixed(4)}`))
      if (i < modelsToDisplay.length - 1) {
        lines.push("├────────────────────────────────────────────────────────┤")
      }
    }
    lines.push("└────────────────────────────────────────────────────────┘")
    lines.push("")
  }

  // Tool Usage section
  if (Object.keys(stats.toolUsage).length > 0) {
    const sortedTools = Object.entries(stats.toolUsage).sort(([, a], [, b]) => b - a)
    const toolsToDisplay = toolLimit ? sortedTools.slice(0, toolLimit) : sortedTools

    lines.push("┌────────────────────────────────────────────────────────┐")
    lines.push("│                      TOOL USAGE                        │")
    lines.push("├────────────────────────────────────────────────────────┤")

    const maxCount = Math.max(...toolsToDisplay.map(([, count]) => count))
    const totalToolUsage = Object.values(stats.toolUsage).reduce((a, b) => a + b, 0)

    for (const [tool, count] of toolsToDisplay) {
      const barLength = Math.max(1, Math.floor((count / maxCount) * 20))
      const bar = "█".repeat(barLength)
      const percentage = ((count / totalToolUsage) * 100).toFixed(1)

      const maxToolLength = 18
      const truncatedTool = tool.length > maxToolLength ? tool.substring(0, maxToolLength - 2) + ".." : tool
      const toolName = truncatedTool.padEnd(maxToolLength)

      const content = ` ${toolName} ${bar.padEnd(20)} ${count.toString().padStart(3)} (${percentage.padStart(4)}%)`
      const padding = Math.max(0, width - content.length - 1)
      lines.push(`│${content}${" ".repeat(padding)} │`)
    }
    lines.push("└────────────────────────────────────────────────────────┘")
    lines.push("")
  }

  return lines
}

export function renderStatsText(
  stats: SessionStats,
  toolLimit?: number,
  modelLimit?: number,
  filters?: {
    days?: number
    project?: string
    provider?: string
    model?: string
  },
  budget?: BudgetStats,
): string {
  return renderStatsLines(stats, toolLimit, modelLimit, filters, budget).join("\n") + "\n"
}

export function displayStats(
  stats: SessionStats,
  toolLimit?: number,
  modelLimit?: number,
  filters?: {
    days?: number
    project?: string
    provider?: string
    model?: string
  },
  budget?: BudgetStats,
) {
  for (const line of renderStatsLines(stats, toolLimit, modelLimit, filters, budget)) {
    console.log(line)
  }
}

function formatNumber(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + "M"
  } else if (num >= 1000) {
    return (num / 1000).toFixed(1) + "K"
  }
  return num.toString()
}
