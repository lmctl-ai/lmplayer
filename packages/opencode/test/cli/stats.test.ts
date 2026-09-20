import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import fs from "fs/promises"
import {
  StatsCommand,
  computeBudgetStats,
  displayStats,
  formatStatsJson,
  renderStatsLines,
  renderStatsText,
  runStats,
  type SessionStats,
} from "../../src/cli/cmd/stats"
import { Session } from "../../src/session/session"
import { MessageID } from "../../src/session/schema"
import { InstanceRef } from "../../src/effect/instance-ref"
import { InstanceRuntime } from "../../src/project/instance-runtime"
import { AppRuntime } from "../../src/effect/app-runtime"
import { tmpdir } from "../fixture/fixture"
import yargs, { type Argv } from "yargs"

describe("StatsCommand options and builder", () => {
  test("StatsCommand registers days, tools, models, project, budget, output, and json options", () => {
    expect(StatsCommand.command).toBe("stats")
    const builder = StatsCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.json).toBeDefined()
    expect(options.boolean).toContain("json")
    expect(options.key.output).toBeDefined()
    expect(options.string).toContain("output")
    expect(options.key.days).toBeDefined()
    expect(options.key.tools).toBeDefined()
    expect(options.key.models).toBeDefined()
    expect(options.key.project).toBeDefined()
    expect(options.key.provider).toBeDefined()
    expect(options.key.model).toBeDefined()
    expect(options.key.budget).toBeDefined()
    expect(options.key["budget-check"]).toBeDefined()
    expect(options.boolean).toContain("budget-check")
  })
})

const sampleStats: SessionStats = {
    totalSessions: 3,
    totalMessages: 12,
    totalCost: 0.045,
    totalTokens: {
      input: 1000,
      output: 500,
      reasoning: 200,
      cache: {
        read: 300,
        write: 100,
      },
    },
    toolUsage: {
      read: 15,
      write: 8,
      edit: 5,
      bash: 2,
    },
    modelUsage: {
      "github-copilot/claude-sonnet-4.6": {
        messages: 8,
        tokens: {
          input: 800,
          output: 400,
          cache: { read: 200, write: 50 },
        },
        cost: 0.035,
      },
      "openai/gpt-4o": {
        messages: 4,
        tokens: {
          input: 200,
          output: 100,
          cache: { read: 100, write: 50 },
        },
        cost: 0.01,
      },
    },
    dateRange: {
      earliest: 1700000000000,
      latest: 1700086400000,
    },
    days: 2,
    costPerDay: 0.0225,
    tokensPerSession: 700,
    medianTokensPerSession: 650,
  }

describe("formatStatsJson", () => {
  test("formats complete structured JSON payload", () => {
    const json = formatStatsJson(sampleStats)
    expect(json.total_sessions).toBe(3)
    expect(json.total_messages).toBe(12)
    expect(json.total_cost).toBe(0.045)
    expect(json.total_tokens.input).toBe(1000)
    expect(json.total_tokens.output).toBe(500)
    expect(json.total_tokens.reasoning).toBe(200)
    expect(json.total_tokens.cache.read).toBe(300)
    expect(json.total_tokens.cache.write).toBe(100)
    expect(json.total_tokens.total).toBe(2100)
    expect(json.averages.cost_per_day).toBe(0.0225)
    expect(json.averages.tokens_per_session).toBe(700)
    expect(json.averages.median_tokens_per_session).toBe(650)
    expect(json.days).toBe(2)
    expect(json.date_range.earliest).toBe(1700000000000)
    expect(json.date_range.latest).toBe(1700086400000)
    expect(Object.keys(json.tool_usage)).toEqual(["read", "write", "edit", "bash"])
    expect(Object.keys(json.model_usage)).toEqual([
      "github-copilot/claude-sonnet-4.6",
      "openai/gpt-4o",
    ])
    expect(json.model_usage["github-copilot/claude-sonnet-4.6"].tokens.total).toBe(1450)
  })

  test("limits tool_usage when toolLimit is specified", () => {
    const json = formatStatsJson(sampleStats, 2)
    expect(Object.keys(json.tool_usage)).toEqual(["read", "write"])
    expect(json.tool_usage.read).toBe(15)
    expect(json.tool_usage.write).toBe(8)
  })

  test("limits model_usage when modelLimit is specified", () => {
    const json = formatStatsJson(sampleStats, undefined, 1)
    expect(Object.keys(json.model_usage)).toEqual(["github-copilot/claude-sonnet-4.6"])
  })

  test("handles empty dataset cleanly", () => {
    const emptyStats: SessionStats = {
      totalSessions: 0,
      totalMessages: 0,
      totalCost: 0,
      totalTokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      toolUsage: {},
      modelUsage: {},
      dateRange: { earliest: 0, latest: 0 },
      days: 0,
      costPerDay: 0,
      tokensPerSession: 0,
      medianTokensPerSession: 0,
    }
    const json = formatStatsJson(emptyStats)
    expect(json.total_sessions).toBe(0)
    expect(json.total_tokens.total).toBe(0)
    expect(json.tool_usage).toEqual({})
    expect(json.model_usage).toEqual({})
  })

  test("includes filters in json output when specified", () => {
    const json = formatStatsJson(sampleStats, undefined, undefined, {
      days: 7,
      project: "test-proj",
      provider: "ollama-cloud",
      model: "deepseek-v4.1-flash",
    })
    expect(json.filters).toEqual({
      days: 7,
      project: "test-proj",
      provider: "ollama-cloud",
      model: "deepseek-v4.1-flash",
    })
  })

  test("computes budget stats correctly when within limit", () => {
    const budget = computeBudgetStats(0.045, 10)
    expect(budget.limit).toBe(10)
    expect(budget.used).toBe(0.045)
    expect(budget.remaining).toBe(9.955)
    expect(budget.percentage).toBe(0.45)
    expect(budget.exceeded).toBe(false)
  })

  test("computes budget stats and flags exceeded when spend meets or exceeds limit", () => {
    const budget = computeBudgetStats(15.5, 10)
    expect(budget.limit).toBe(10)
    expect(budget.used).toBe(15.5)
    expect(budget.remaining).toBe(0)
    expect(budget.percentage).toBe(155)
    expect(budget.exceeded).toBe(true)

    const exactBudget = computeBudgetStats(10, 10)
    expect(exactBudget.exceeded).toBe(true)
    expect(exactBudget.remaining).toBe(0)
  })

  test("includes budget in JSON output when budget is provided", () => {
    const budget = computeBudgetStats(sampleStats.totalCost, 5)
    const json = formatStatsJson(sampleStats, undefined, undefined, undefined, budget)
    expect(json.budget).toEqual({
      limit: 5,
      used: 0.045,
      remaining: 4.955,
      percentage: 0.9,
      exceeded: false,
    })
  })
})

describe("displayStats", () => {
  test("prints formatted overview, metrics, tool and model sections with filters", () => {
    const logs: string[] = []
    const originalLog = console.log
    console.log = (...args: any[]) => {
      logs.push(args.map(String).join(" "))
    }

    try {
      displayStats(sampleStats, undefined, undefined, {
        provider: "ollama-cloud",
        model: "deepseek-v4.1-flash",
        project: "test-proj",
      })

      const joined = logs.join("\n")
      expect(joined).toContain("OVERVIEW")
      expect(joined).toContain("Sessions")
      expect(joined).toContain("Provider")
      expect(joined).toContain("ollama-cloud")
      expect(joined).toContain("Model")
      expect(joined).toContain("deepseek-v4.1-flash")
      expect(joined).toContain("Project")
      expect(joined).toContain("test-proj")
      expect(joined).toContain("COST & TOKENS")
      expect(joined).toContain("Total Cost")
      expect(joined).toContain("TOOL USAGE")
    } finally {
      console.log = originalLog
    }
  })

  test("prints BUDGET box with limit, spend, remaining, and status when budget provided", () => {
    const logs: string[] = []
    const originalLog = console.log
    console.log = (...args: any[]) => {
      logs.push(args.map(String).join(" "))
    }

    try {
      // Within budget
      const withinBudget = computeBudgetStats(sampleStats.totalCost, 10)
      displayStats(sampleStats, undefined, undefined, undefined, withinBudget)
      let joined = logs.join("\n")
      expect(joined).toContain("BUDGET")
      expect(joined).toContain("Budget Limit")
      expect(joined).toContain("$10.00")
      expect(joined).toContain("Total Spend")
      expect(joined).toContain("Remaining")
      expect(joined).toContain("Status")
      expect(joined).toContain("WITHIN BUDGET")

      // Exceeded budget
      logs.length = 0
      const exceededBudget = computeBudgetStats(12.5, 10)
      displayStats({ ...sampleStats, totalCost: 12.5 }, undefined, undefined, undefined, exceededBudget)
      joined = logs.join("\n")
      expect(joined).toContain("BUDGET")
      expect(joined).toContain("EXCEEDED [ALERT]")
    } finally {
      console.log = originalLog
    }
  })
})

describe("renderStatsText and renderStatsLines", () => {
  test("renders complete table text with overview, metrics, budget, model, and tool usage", () => {
    const budget = computeBudgetStats(sampleStats.totalCost, 10)
    const text = renderStatsText(
      sampleStats,
      2,
      2,
      {
        provider: "github-copilot",
        model: "claude-sonnet-4.6",
        project: "test-proj",
      },
      budget,
    )

    expect(text).toContain("OVERVIEW")
    expect(text).toContain("Sessions")
    expect(text).toContain("3")
    expect(text).toContain("Provider")
    expect(text).toContain("github-copilot")
    expect(text).toContain("Model")
    expect(text).toContain("claude-sonnet-4.6")
    expect(text).toContain("Project")
    expect(text).toContain("test-proj")
    expect(text).toContain("COST & TOKENS")
    expect(text).toContain("Total Cost")
    expect(text).toContain("$0.04")
    expect(text).toContain("BUDGET")
    expect(text).toContain("Budget Limit")
    expect(text).toContain("$10.00")
    expect(text).toContain("WITHIN BUDGET")
    expect(text).toContain("MODEL USAGE")
    expect(text).toContain("TOOL USAGE")
    expect(text.endsWith("\n")).toBe(true)

    const lines = renderStatsLines(sampleStats, 2, 2, undefined, budget)
    expect(lines.length).toBeGreaterThan(10)
    expect(lines[0]).toBe("┌────────────────────────────────────────────────────────┐")
  })
})

describe("StatsCommand in-process execution", () => {
  test("executes stats --json and outputs valid JSON", async () => {
    const tmp = await tmpdir({ git: true })
    const ctx = await InstanceRuntime.load({ directory: tmp.path })

    let captured = ""
    const originalWrite = process.stdout.write
    process.stdout.write = ((chunk: any) => {
      captured += String(chunk)
      return true
    }) as any

    try {
      // 1. Run stats --json on empty database
      await AppRuntime.runPromise(
        runStats({ json: true }).pipe(Effect.provideService(InstanceRef, ctx)),
      )

      const emptyData = JSON.parse(captured)
      expect(emptyData.total_sessions).toBe(0)
      expect(emptyData.total_messages).toBe(0)
      expect(emptyData.total_cost).toBe(0)
      expect(emptyData.total_tokens.total).toBe(0)

      // 2. Create session and run again
      captured = ""
      await AppRuntime.runPromise(
        Session.Service.use((svc) => svc.create({ title: "Test Session" })).pipe(
          Effect.provideService(InstanceRef, ctx),
        ),
      )

      await AppRuntime.runPromise(
        runStats({ json: true }).pipe(Effect.provideService(InstanceRef, ctx)),
      )

      const withSession = JSON.parse(captured)
      expect(withSession.total_sessions).toBe(1)
      expect(typeof withSession.total_tokens).toBe("object")
    } finally {
      process.stdout.write = originalWrite
      await InstanceRuntime.disposeInstance(ctx)
    }
  })

  test("filters sessions and metrics by provider and model", async () => {
    const tmp = await tmpdir({ git: true })
    const ctx = await InstanceRuntime.load({ directory: tmp.path })

    let captured = ""
    const originalWrite = process.stdout.write
    process.stdout.write = ((chunk: any) => {
      captured += String(chunk)
      return true
    }) as any

    try {
      const session = await AppRuntime.runPromise(
        Session.Service.use((svc) => svc.create({ title: "Test Filter Session" })).pipe(
          Effect.provideService(InstanceRef, ctx),
        ),
      )

      await AppRuntime.runPromise(
        Session.Service.use((svc) =>
          svc.updateMessage({
            id: MessageID.ascending(),
            sessionID: session.id,
            parentID: MessageID.ascending(),
            role: "assistant",
            time: { created: Date.now() },
            providerID: "ollama-cloud",
            modelID: "deepseek-v4.1-flash",
            mode: "",
            agent: "agent",
            path: { cwd: "/", root: "/" },
            cost: 0.005,
            tokens: {
              input: 100,
              output: 50,
              reasoning: 20,
              cache: { read: 10, write: 5 },
            },
          } as any),
        ).pipe(Effect.provideService(InstanceRef, ctx)),
      )

      // 1. Filter by matching provider
      captured = ""
      await AppRuntime.runPromise(
        runStats({ provider: "ollama-cloud", json: true }).pipe(
          Effect.provideService(InstanceRef, ctx),
        ),
      )
      const providerData = JSON.parse(captured)
      expect(providerData.total_sessions).toBe(1)
      expect(providerData.total_messages).toBe(1)
      expect(providerData.total_cost).toBe(0.005)
      expect(providerData.total_tokens.input).toBe(100)
      expect(providerData.total_tokens.output).toBe(50)
      expect(providerData.total_tokens.reasoning).toBe(20)
      expect(providerData.filters?.provider).toBe("ollama-cloud")
      expect(providerData.model_usage["ollama-cloud/deepseek-v4.1-flash"]).toBeDefined()

      // 2. Filter by non-matching provider
      captured = ""
      await AppRuntime.runPromise(
        runStats({ provider: "openai", json: true }).pipe(
          Effect.provideService(InstanceRef, ctx),
        ),
      )
      const nonMatching = JSON.parse(captured)
      expect(nonMatching.total_sessions).toBe(0)
      expect(nonMatching.total_messages).toBe(0)
      expect(nonMatching.total_cost).toBe(0)
      expect(nonMatching.filters?.provider).toBe("openai")

      // 3. Filter by model ID
      captured = ""
      await AppRuntime.runPromise(
        runStats({ model: "deepseek-v4.1-flash", json: true }).pipe(
          Effect.provideService(InstanceRef, ctx),
        ),
      )
      const modelData = JSON.parse(captured)
      expect(modelData.total_sessions).toBe(1)
      expect(modelData.total_messages).toBe(1)
      expect(modelData.filters?.model).toBe("deepseek-v4.1-flash")

      // 4. Filter by full provider/model ID
      captured = ""
      await AppRuntime.runPromise(
        runStats({ model: "ollama-cloud/deepseek-v4.1-flash", json: true }).pipe(
          Effect.provideService(InstanceRef, ctx),
        ),
      )
      const fullModelData = JSON.parse(captured)
      expect(fullModelData.total_sessions).toBe(1)
      expect(fullModelData.total_messages).toBe(1)

      // 5. Budget option in JSON output
      captured = ""
      await AppRuntime.runPromise(
        runStats({ budget: 10, json: true }).pipe(Effect.provideService(InstanceRef, ctx)),
      )
      const budgetData = JSON.parse(captured)
      expect(budgetData.budget).toBeDefined()
      expect(budgetData.budget.limit).toBe(10)
      expect(budgetData.budget.used).toBe(0.005)
      expect(budgetData.budget.exceeded).toBe(false)

      // 6. Budget check passes when within budget
      await AppRuntime.runPromise(
        runStats({ budget: 10, budgetCheck: true, json: true }).pipe(Effect.provideService(InstanceRef, ctx)),
      )

      // 7. Budget check fails when spending exceeds budget
      await expect(
        AppRuntime.runPromise(
          runStats({ budget: 0.001, budgetCheck: true, json: true }).pipe(Effect.provideService(InstanceRef, ctx)),
        ),
      ).rejects.toThrow(/Budget limit exceeded/)

      // 8. Budget check without budget fails
      await expect(
        AppRuntime.runPromise(
          runStats({ budgetCheck: true, json: true }).pipe(Effect.provideService(InstanceRef, ctx)),
        ),
      ).rejects.toThrow(/--budget-check requires --budget/)

      // 9. Negative budget fails
      await expect(
        AppRuntime.runPromise(
          runStats({ budget: -5, json: true }).pipe(Effect.provideService(InstanceRef, ctx)),
        ),
      ).rejects.toThrow(/--budget must be a non-negative number/)
    } finally {
      process.stdout.write = originalWrite
      await InstanceRuntime.disposeInstance(ctx)
    }
  })

  test("exports stats to file with --output in both json and table text mode", async () => {
    const tmp = await tmpdir({ git: true })
    const ctx = await InstanceRuntime.load({ directory: tmp.path })

    try {
      const session = await AppRuntime.runPromise(
        Session.Service.use((svc) => svc.create({ title: "Export Test Session" })).pipe(
          Effect.provideService(InstanceRef, ctx),
        ),
      )

      await AppRuntime.runPromise(
        Session.Service.use((svc) =>
          svc.updateMessage({
            id: MessageID.ascending(),
            sessionID: session.id,
            parentID: MessageID.ascending(),
            role: "assistant",
            time: { created: Date.now() },
            providerID: "ollama-cloud",
            modelID: "deepseek-v4.1-flash",
            mode: "",
            agent: "agent",
            path: { cwd: "/", root: "/" },
            cost: 0.012,
            tokens: {
              input: 200,
              output: 100,
              reasoning: 40,
              cache: { read: 20, write: 10 },
            },
          } as any),
        ).pipe(Effect.provideService(InstanceRef, ctx)),
      )

      // 1. JSON file export
      const jsonOutPath = path.join(tmp.path, "nested", "stats.json")
      await AppRuntime.runPromise(
        runStats({ json: true, output: jsonOutPath, project: "" }).pipe(
          Effect.provideService(InstanceRef, ctx),
        ),
      )
      const jsonExists = await fs.stat(jsonOutPath).then(() => true, () => false)
      expect(jsonExists).toBe(true)
      const parsed = JSON.parse(await fs.readFile(jsonOutPath, "utf-8"))
      expect(parsed.total_sessions).toBe(1)
      expect(parsed.total_cost).toBe(0.012)
      expect(parsed.total_tokens.input).toBe(200)

      // 2. Text table file export
      const textOutPath = path.join(tmp.path, "reports", "stats.txt")
      await AppRuntime.runPromise(
        runStats({ output: textOutPath, provider: "ollama-cloud" }).pipe(
          Effect.provideService(InstanceRef, ctx),
        ),
      )
      const textExists = await fs.stat(textOutPath).then(() => true, () => false)
      expect(textExists).toBe(true)
      const textContent = await fs.readFile(textOutPath, "utf-8")
      expect(textContent).toContain("OVERVIEW")
      expect(textContent).toContain("Provider")
      expect(textContent).toContain("ollama-cloud")
      expect(textContent).toContain("COST & TOKENS")
      expect(textContent).toContain("Total Cost")
      expect(textContent).toContain("$0.01")

      // 3. File export with budget check failure still writes the file before failing
      const budgetOutPath = path.join(tmp.path, "reports", "budget-fail.txt")
      await expect(
        AppRuntime.runPromise(
          runStats({ budget: 0.001, budgetCheck: true, output: budgetOutPath }).pipe(
            Effect.provideService(InstanceRef, ctx),
          ),
        ),
      ).rejects.toThrow(/Budget limit exceeded/)
      const budgetExists = await fs.stat(budgetOutPath).then(() => true, () => false)
      expect(budgetExists).toBe(true)
    } finally {
      await InstanceRuntime.disposeInstance(ctx)
    }
  })
})
