import { describe, expect, test } from "bun:test"
import {
  filterModel,
  modelsList,
  ModelsListCommand,
  ModelsCommand,
  modelToDetailJson,
  modelToJsonEntry,
  ModelsShowCommand,
  parseModelFilterOptions,
  resolveVerify,
} from "../../src/cli/cmd/models"
import { ProviderTest } from "../fake/provider"
import yargs, { type Argv } from "yargs"
import type { ModelsDev } from "@opencode-ai/core/models-dev"
import type { Auth } from "../../src/auth"
import type { Provider } from "@/provider/provider"
import { Effect, Exit } from "effect"
import { InstanceRef } from "../../src/effect/instance-ref"
import { InstanceRuntime } from "../../src/project/instance-runtime"
import { AppRuntime } from "../../src/effect/app-runtime"
import { tmpdir } from "../fixture/fixture"

// ─── modelToJsonEntry shape ───────────────────────────────────────────────────

describe("modelToJsonEntry", () => {
  test("emits required --json shape with available: true", () => {
    const model = ProviderTest.model()
    const entry = modelToJsonEntry("test-provider", String(model.id), model)

    expect(entry.id).toBe(`test-provider/${model.id}`)
    expect(entry.provider).toBe("test-provider")
    expect(typeof entry.name).toBe("string")
    expect(typeof entry.available).toBe("boolean")
    expect(entry.available).toBe(true)
    expect(Array.isArray(entry.variants)).toBe(true)
    expect(typeof entry.limit).toBe("object")
    expect(typeof entry.capabilities).toBe("object")
  })

  test("variants lists variant keys from model.variants", () => {
    const model = ProviderTest.model({ variants: { low: {}, medium: {}, high: {} } })
    const entry = modelToJsonEntry("p", String(model.id), model)
    expect(entry.variants).toEqual(expect.arrayContaining(["low", "medium", "high"]))
    expect(entry.variants).toHaveLength(3)
  })

  test("variants is empty array when model has no variants", () => {
    const model = ProviderTest.model({ variants: undefined })
    const entry = modelToJsonEntry("p", String(model.id), model)
    expect(entry.variants).toEqual([])
    expect(entry.available).toBe(true)
  })
})

// ─── modelToDetailJson shape ──────────────────────────────────────────────────

describe("modelToDetailJson", () => {
  test("emits detailed model JSON shape with cost, capabilities, limits, and variants", () => {
    const model = ProviderTest.model({
      family: "claude-sonnet",
      status: "active",
      release_date: "2025-02-24",
      variants: { low: {}, medium: {}, high: {} },
      cost: {
        input: 3,
        output: 15,
        cache: { read: 0.3, write: 3.75 },
      },
    })
    const detail = modelToDetailJson("github-copilot", String(model.id), model, "GitHub Copilot")

    expect(detail.id).toBe(`github-copilot/${model.id}`)
    expect(detail.provider).toEqual({ id: "github-copilot", name: "GitHub Copilot" })
    expect(detail.name).toBe(model.name)
    expect(detail.family).toBe("claude-sonnet")
    expect(detail.status).toBe("active")
    expect(detail.release_date).toBe("2025-02-24")
    expect(detail.available).toBe(true)
    expect(detail.variants).toEqual(["low", "medium", "high"])
    expect(detail.cost).toEqual({
      input: 3,
      output: 15,
      cache: { read: 0.3, write: 3.75 },
    })
    expect(detail.limit).toEqual({
      context: model.limit.context ?? null,
      input: model.limit.input ?? null,
      output: model.limit.output ?? null,
    })
    expect(detail.capabilities.reasoning).toBe(model.capabilities.reasoning)
    expect(detail.capabilities.toolcall).toBe(model.capabilities.toolcall)
  })

  test("handles model with null cost and no variants", () => {
    const model = ProviderTest.model({
      cost: undefined,
      variants: undefined,
      family: undefined,
    })
    const detail = modelToDetailJson("test-provider", String(model.id), model, "Test")

    expect(detail.id).toBe(`test-provider/${model.id}`)
    expect(detail.cost).toBeNull()
    expect(detail.variants).toEqual([])
    expect(detail.family).toBeUndefined()
  })
})

// ─── resolveVerify ────────────────────────────────────────────────────────────

// Minimal fake provider catalog. Models only need to be present as keys; the
// resolveVerify function never reads model field values, only their existence.
const mockDatabase: Record<string, ModelsDev.Provider> = {
  "test-provider": {
    id: "test-provider",
    name: "Test Provider",
    env: ["TEST_PROVIDER_API_KEY"],
    models: {
      "model-a": {} as ModelsDev.Model,
    },
  },
}

const mockCreds: Record<string, Auth.Info> = {
  "test-provider": { type: "api", key: "sk-test" },
}
const emptyCreds: Record<string, Auth.Info> = {}

describe("resolveVerify – format validation", () => {
  test("fails when no slash", () => {
    const r = resolveVerify("noslash", undefined, mockDatabase, mockCreds)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/providerID\/modelID/)
  })

  test("fails when slash is first character", () => {
    const r = resolveVerify("/model-a", undefined, mockDatabase, mockCreds)
    expect(r.ok).toBe(false)
  })

  test("fails when slash is last character", () => {
    const r = resolveVerify("test-provider/", undefined, mockDatabase, mockCreds)
    expect(r.ok).toBe(false)
  })
})

describe("resolveVerify – catalog checks", () => {
  test("fails for unknown provider", () => {
    const r = resolveVerify("unknown-provider/model-a", undefined, mockDatabase, mockCreds)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/unknown provider/)
  })

  test("fails for unknown model within known provider", () => {
    const r = resolveVerify("test-provider/nonexistent-model", undefined, mockDatabase, mockCreds)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/unknown model/)
  })

  test("returns ok for known model in authenticated provider", () => {
    const r = resolveVerify("test-provider/model-a", undefined, mockDatabase, mockCreds)
    expect(r.ok).toBe(true)
  })
})

describe("resolveVerify – authentication", () => {
  test("fails when provider is not in creds and no env var set", () => {
    const r = resolveVerify("test-provider/model-a", undefined, mockDatabase, emptyCreds)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not authenticated/)
  })

  test("reason includes env var hint when env vars are defined", () => {
    const r = resolveVerify("test-provider/model-a", undefined, mockDatabase, emptyCreds)
    if (!r.ok) expect(r.reason).toMatch(/TEST_PROVIDER_API_KEY/)
  })

  test("succeeds when provider env var is set (no stored creds needed)", () => {
    const saved = process.env["TEST_PROVIDER_API_KEY"]
    try {
      process.env["TEST_PROVIDER_API_KEY"] = "env-key"
      const r = resolveVerify("test-provider/model-a", undefined, mockDatabase, emptyCreds)
      expect(r.ok).toBe(true)
    } finally {
      if (saved === undefined) delete process.env["TEST_PROVIDER_API_KEY"]
      else process.env["TEST_PROVIDER_API_KEY"] = saved
    }
  })
})

describe("resolveVerify – effort/variant validation", () => {
  const builtWithEfforts = {
    models: {
      "model-a": { variants: { low: {}, medium: {}, high: {} } },
    },
  }

  const builtNoEfforts = {
    models: {
      "model-a": { variants: {} },
    },
  }

  test("accepts valid effort", () => {
    const r = resolveVerify("test-provider/model-a", "medium", mockDatabase, mockCreds, builtWithEfforts)
    expect(r.ok).toBe(true)
  })

  test("accepts all valid efforts", () => {
    for (const effort of ["low", "medium", "high"]) {
      const r = resolveVerify("test-provider/model-a", effort, mockDatabase, mockCreds, builtWithEfforts)
      expect(r.ok).toBe(true)
    }
  })

  test("rejects unknown effort", () => {
    const r = resolveVerify("test-provider/model-a", "xhigh", mockDatabase, mockCreds, builtWithEfforts)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toMatch(/effort/)
      expect(r.reason).toMatch(/xhigh/)
    }
  })

  test("reason lists valid efforts when rejecting", () => {
    const r = resolveVerify("test-provider/model-a", "max", mockDatabase, mockCreds, builtWithEfforts)
    if (!r.ok) {
      expect(r.reason).toMatch(/low/)
      expect(r.reason).toMatch(/medium/)
      expect(r.reason).toMatch(/high/)
    }
  })

  test("rejects any effort when model has no variants", () => {
    const r = resolveVerify("test-provider/model-a", "medium", mockDatabase, mockCreds, builtNoEfforts)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/none/)
  })
})

describe("ModelsTestCommand definition", () => {
  test("ModelsTestCommand has command test [provider]", async () => {
    const { ModelsTestCommand } = await import("../../src/cli/cmd/models")
    expect(ModelsTestCommand).toBeDefined()
    expect(ModelsTestCommand.command).toBe("test [provider]")
  })
})

describe("ModelsShowCommand definition and builder", () => {
  test("has command show <model> and alias get", () => {
    expect(ModelsShowCommand.command).toBe("show <model>")
    expect(ModelsShowCommand.aliases).toContain("get")
  })

  test("registers model positional and json option", () => {
    const builder = ModelsShowCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.json).toBeDefined()
    expect(options.boolean).toContain("json")
  })
})

// ─── filterModel ─────────────────────────────────────────────────────────────

describe("filterModel", () => {
  const testCaps = (override: Partial<Provider.Model["capabilities"]> = {}) => ({
    ...ProviderTest.model().capabilities,
    ...override,
  })

  const model = ProviderTest.model({
    name: "Claude 3.7 Sonnet",
    capabilities: testCaps({
      reasoning: true,
      toolcall: true,
      attachment: true,
      temperature: true,
    }),
    limit: { context: 200_000, input: 200_000, output: 8192 },
  })

  test("accepts when no filters are set", () => {
    expect(filterModel("anthropic", "claude-3-7-sonnet", model, {})).toBe(true)
  })

  test("matches search by model ID", () => {
    expect(filterModel("anthropic", "claude-3-7-sonnet", model, { search: "sonnet" })).toBe(true)
    expect(filterModel("anthropic", "claude-3-7-sonnet", model, { search: "claude-3" })).toBe(true)
  })

  test("matches search by model name case-insensitively", () => {
    expect(filterModel("anthropic", "claude-3-7-sonnet", model, { search: "Claude" })).toBe(true)
    expect(filterModel("anthropic", "claude-3-7-sonnet", model, { search: "3.7" })).toBe(true)
  })

  test("matches search by provider ID", () => {
    expect(filterModel("anthropic", "claude-3-7-sonnet", model, { search: "anthropic" })).toBe(true)
  })

  test("rejects search when no match", () => {
    expect(filterModel("anthropic", "claude-3-7-sonnet", model, { search: "gpt-4o" })).toBe(false)
  })

  test("filters by reasoning capability", () => {
    expect(filterModel("anthropic", "claude-3-7-sonnet", model, { reasoning: true })).toBe(true)
    const noReasoning = ProviderTest.model({
      capabilities: testCaps({ reasoning: false, toolcall: true, attachment: true, temperature: true }),
    })
    expect(filterModel("anthropic", "m1", noReasoning, { reasoning: true })).toBe(false)
  })

  test("filters by toolcall capability", () => {
    expect(filterModel("anthropic", "claude-3-7-sonnet", model, { toolcall: true })).toBe(true)
    const noTool = ProviderTest.model({
      capabilities: testCaps({ reasoning: false, toolcall: false, attachment: true, temperature: true }),
    })
    expect(filterModel("anthropic", "m1", noTool, { toolcall: true })).toBe(false)
  })

  test("filters by attachment capability", () => {
    expect(filterModel("anthropic", "claude-3-7-sonnet", model, { attachment: true })).toBe(true)
    const noAttach = ProviderTest.model({
      capabilities: testCaps({ reasoning: false, toolcall: true, attachment: false, temperature: true }),
    })
    expect(filterModel("anthropic", "m1", noAttach, { attachment: true })).toBe(false)
  })

  test("filters by minContext", () => {
    expect(filterModel("anthropic", "claude-3-7-sonnet", model, { minContext: 128_000 })).toBe(true)
    expect(filterModel("anthropic", "claude-3-7-sonnet", model, { minContext: 200_000 })).toBe(true)
    expect(filterModel("anthropic", "claude-3-7-sonnet", model, { minContext: 500_000 })).toBe(false)
  })

  test("combines multiple filter predicates", () => {
    expect(
      filterModel("anthropic", "claude-3-7-sonnet", model, {
        search: "sonnet",
        reasoning: true,
        toolcall: true,
        minContext: 100_000,
      }),
    ).toBe(true)

    expect(
      filterModel("anthropic", "claude-3-7-sonnet", model, {
        search: "sonnet",
        reasoning: true,
        toolcall: true,
        minContext: 300_000,
      }),
    ).toBe(false)
  })
})

// ─── parseModelFilterOptions ──────────────────────────────────────────────────

describe("parseModelFilterOptions", () => {
  test("parses flag aliases", () => {
    const opts = parseModelFilterOptions({
      q: "sonnet",
      r: true,
      tools: true,
      attachments: true,
      "min-context": 128_000,
    })
    expect(opts.search).toBe("sonnet")
    expect(opts.reasoning).toBe(true)
    expect(opts.toolcall).toBe(true)
    expect(opts.attachment).toBe(true)
    expect(opts.minContext).toBe(128_000)
  })

  test("handles empty options", () => {
    const opts = parseModelFilterOptions({})
    expect(opts.search).toBeUndefined()
    expect(opts.reasoning).toBe(false)
    expect(opts.toolcall).toBe(false)
    expect(opts.attachment).toBe(false)
    expect(opts.minContext).toBeUndefined()
  })
})

// ─── ModelsListCommand definition and builder ────────────────────────────────

describe("ModelsListCommand and ModelsCommand definition and builder", () => {
  test("ModelsListCommand has command list [provider] and alias ls", () => {
    expect(ModelsListCommand.command).toBe("list [provider]")
    expect(ModelsListCommand.aliases).toContain("ls")
  })

  test("ModelsListCommand builder registers all filter and output options", () => {
    const builder = ModelsListCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.search).toBeDefined()
    expect(options.key.reasoning).toBeDefined()
    expect(options.key.toolcall).toBeDefined()
    expect(options.key.attachment).toBeDefined()
    expect(options.key["min-context"]).toBeDefined()
    expect(options.key.json).toBeDefined()
    expect(options.key.verbose).toBeDefined()
    expect(options.key.refresh).toBeDefined()
  })

  test("ModelsCommand builder registers test, timeout, and concurrency options", () => {
    const builder = ModelsCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.test).toBeDefined()
    expect(options.key.timeout).toBeDefined()
    expect(options.key.concurrency).toBeDefined()
    expect(options.key.search).toBeDefined()
  })
})

// ─── modelsList in-process handler ───────────────────────────────────────────

describe("modelsList in-process handler", () => {
  const runModelsList = (args: any, ctx: any) =>
    AppRuntime.runPromise(modelsList(args).pipe(Effect.provideService(InstanceRef, ctx)))

  const runModelsListExit = (args: any, ctx: any) =>
    AppRuntime.runPromiseExit(modelsList(args).pipe(Effect.provideService(InstanceRef, ctx)))

  test("fails cleanly for unknown provider", async () => {
    const tmp = await tmpdir({ git: true })
    const ctx = await InstanceRuntime.load({ directory: tmp.path })
    try {
      const exit = await runModelsListExit({ provider: "totally-unknown-provider-999" }, ctx)
      expect(Exit.isFailure(exit)).toBe(true)
    } finally {
      await InstanceRuntime.disposeInstance(ctx)
    }
  })

  test("lists ollama models as json", async () => {
    const tmp = await tmpdir({ git: true })
    const ctx = await InstanceRuntime.load({ directory: tmp.path })
    let captured = ""
    const originalWrite = process.stdout.write
    process.stdout.write = ((chunk: any) => {
      captured += String(chunk)
      return true
    }) as any

    try {
      await runModelsList({ provider: "ollama", json: true }, ctx)
      const data = JSON.parse(captured)
      expect(Array.isArray(data)).toBe(true)
      expect(data.length).toBeGreaterThan(0)
      const first = data[0]
      expect(first.provider).toBe("ollama")
      expect(first.available).toBe(true)
      expect(typeof first.id).toBe("string")
      expect(typeof first.name).toBe("string")
      expect(typeof first.limit).toBe("object")
      expect(typeof first.capabilities).toBe("object")
    } finally {
      process.stdout.write = originalWrite
      await InstanceRuntime.disposeInstance(ctx)
    }
  })

  test("filters models by search query in json mode", async () => {
    const tmp = await tmpdir({ git: true })
    const ctx = await InstanceRuntime.load({ directory: tmp.path })
    let captured = ""
    const originalWrite = process.stdout.write
    process.stdout.write = ((chunk: any) => {
      captured += String(chunk)
      return true
    }) as any

    try {
      await runModelsList({ provider: "ollama", search: "qwen", json: true }, ctx)
      const data = JSON.parse(captured)
      expect(Array.isArray(data)).toBe(true)
      for (const entry of data) {
        const matches =
          entry.id.toLowerCase().includes("qwen") ||
          entry.name.toLowerCase().includes("qwen") ||
          entry.provider.toLowerCase().includes("qwen")
        expect(matches).toBe(true)
      }
    } finally {
      process.stdout.write = originalWrite
      await InstanceRuntime.disposeInstance(ctx)
    }
  })

  test("filters models by capabilities in json mode", async () => {
    const tmp = await tmpdir({ git: true })
    const ctx = await InstanceRuntime.load({ directory: tmp.path })
    let captured = ""
    const originalWrite = process.stdout.write
    process.stdout.write = ((chunk: any) => {
      captured += String(chunk)
      return true
    }) as any

    try {
      await runModelsList({ provider: "ollama", toolcall: true, json: true }, ctx)
      const data = JSON.parse(captured)
      expect(Array.isArray(data)).toBe(true)
      for (const entry of data) {
        expect(entry.capabilities.toolcall).toBe(true)
      }
    } finally {
      process.stdout.write = originalWrite
      await InstanceRuntime.disposeInstance(ctx)
    }
  })
})


