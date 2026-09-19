import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { StatsCommand, formatStatsJson, runStats, type SessionStats } from "../../src/cli/cmd/stats"
import { Session } from "../../src/session/session"
import { MessageID } from "../../src/session/schema"
import { InstanceRef } from "../../src/effect/instance-ref"
import { InstanceRuntime } from "../../src/project/instance-runtime"
import { AppRuntime } from "../../src/effect/app-runtime"
import { tmpdir } from "../fixture/fixture"
import yargs, { type Argv } from "yargs"

describe("StatsCommand options and builder", () => {
  test("StatsCommand registers days, tools, models, project, and json options", () => {
    expect(StatsCommand.command).toBe("stats")
    const builder = StatsCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.json).toBeDefined()
    expect(options.boolean).toContain("json")
    expect(options.key.days).toBeDefined()
    expect(options.key.tools).toBeDefined()
    expect(options.key.models).toBeDefined()
    expect(options.key.project).toBeDefined()
    expect(options.key.provider).toBeDefined()
    expect(options.key.model).toBeDefined()
  })
})

describe("formatStatsJson", () => {
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
    } finally {
      process.stdout.write = originalWrite
      await InstanceRuntime.disposeInstance(ctx)
    }
  })
})
