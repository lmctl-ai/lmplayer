import { describe, expect, test } from "bun:test"
import { modelToJsonEntry, resolveVerify } from "../../src/cli/cmd/models"
import { ProviderTest } from "../fake/provider"
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
