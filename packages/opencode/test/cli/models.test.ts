import { describe, expect, test } from "bun:test"
import { modelToDetailJson, modelToJsonEntry, ModelsShowCommand, resolveVerify } from "../../src/cli/cmd/models"
import { ProviderTest } from "../fake/provider"
import yargs, { type Argv } from "yargs"
import type { ModelsDev } from "@opencode-ai/core/models-dev"
import type { Auth } from "../../src/auth"

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


