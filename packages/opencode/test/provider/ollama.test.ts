import { afterEach, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin/index"
import { Provider } from "@/provider/provider"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { resolveVerify } from "@/cli/cmd/models"

const originalEnv = new Map<string, string | undefined>()

const rememberEnv = (k: string) => {
  if (!originalEnv.has(k)) originalEnv.set(k, process.env[k])
}

const set = (k: string, v: string) =>
  Effect.gen(function* () {
    rememberEnv(k)
    process.env[k] = v
    yield* Env.use.set(k, v)
  })

afterEach(async () => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  originalEnv.clear()
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Provider.node, Config.node, Auth.node, Env.node, Plugin.node, ModelsDev.node, RuntimeFlags.node]),
  ),
)

const list = Provider.use.list()

// openai-compatible language models close over the base URL in a `url({ path })`
// function (see @ai-sdk/openai-compatible's `createOpenAICompatible`), not a
// plain `config.baseURL` string like anthropic/google-vertex — so we resolve
// it the same way the SDK itself does, by calling that function with an empty
// path, rather than reusing provider.test.ts's anthropic-only `languageBaseURL`.
const openaiCompatibleBaseURL = (language: unknown) =>
  (language as { config: { url: (input: { path: string; modelId: string }) => string } }).config.url({
    path: "",
    modelId: "",
  })

// ─── pure helpers (no runtime) ───────────────────────────────────────────────

test("parseOllamaModel defaults to localhost", () => {
  const result = Provider.parseOllamaModel("qwen2.5")
  expect(result.model).toBe("qwen2.5")
  expect(result.baseURL).toBe("http://localhost:11434/v1")
})

test("parseOllamaModel honors an in-name @host override", () => {
  const result = Provider.parseOllamaModel("qwen2.5@192.168.1.5:11434")
  expect(result.model).toBe("qwen2.5")
  expect(result.baseURL).toBe("http://192.168.1.5:11434/v1")
})

test("parseOllamaModel honors OLLAMA_HOST env when no @host override is given", () => {
  const result = Provider.parseOllamaModel("qwen2.5", { OLLAMA_HOST: "http://box:11434" })
  expect(result.model).toBe("qwen2.5")
  expect(result.baseURL).toBe("http://box:11434/v1")
})

test("parseOllamaModel: @host override wins over OLLAMA_HOST env", () => {
  const result = Provider.parseOllamaModel("qwen2.5@192.168.1.5:11434", { OLLAMA_HOST: "http://box:11434" })
  expect(result.baseURL).toBe("http://192.168.1.5:11434/v1")
})

test("ollamaModel synthesizes a chat-only, openai-compatible model", () => {
  const model = Provider.ollamaModel("qwen2.5")
  expect(model.capabilities.toolcall).toBe(false)
  expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
  expect(model.api.url).toBe("http://localhost:11434/v1")
  expect(model.api.id).toBe("qwen2.5")
})

test("resolveVerify treats any ollama/<model> as ok with no creds needed", () => {
  const result = resolveVerify("ollama/qwen2.5", undefined, {}, {})
  expect(result).toEqual({ ok: true })
})

// ─── instance tests (config-free: no config, no env) ────────────────────────

it.instance("providers list includes ollama with the seeded models when no config is present", () =>
  Effect.gen(function* () {
    const providers = yield* list
    const ollama = providers[ProviderV2.ID.make("ollama")]
    expect(ollama).toBeDefined()
    expect(ollama.source).toBe("custom")
    expect(Object.keys(ollama.models)).toContain("qwen2.5")
    expect(Object.keys(ollama.models)).toContain("qwen2.5-coder")
    expect(Object.keys(ollama.models)).toContain("llama3.2")
    expect(Object.keys(ollama.models)).toContain("llama3.1")
    expect(Object.keys(ollama.models)).toContain("mistral")
  }),
)

it.instance("getModel(ollama, qwen2.5) resolves and getLanguage baseURL defaults to localhost", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const model = yield* provider.getModel(ProviderV2.ID.make("ollama"), ModelV2.ID.make("qwen2.5"))
    expect(model).toBeDefined()
    expect(model.capabilities.toolcall).toBe(false)
    const language = yield* provider.getLanguage(model)
    expect(openaiCompatibleBaseURL(language)).toBe("http://localhost:11434/v1")
  }),
)

it.instance("getModel(ollama, qwen2.5:7b) synthesizes an arbitrary tag on demand", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const model = yield* provider.getModel(ProviderV2.ID.make("ollama"), ModelV2.ID.make("qwen2.5:7b"))
    expect(model).toBeDefined()
    expect(model.api.id).toBe("qwen2.5:7b")
    expect(model.capabilities.toolcall).toBe(false)
  }),
)

it.instance("getModel(ollama, llama3@10.0.0.5:11434) resolves an in-name host override", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const model = yield* provider.getModel(ProviderV2.ID.make("ollama"), ModelV2.ID.make("llama3@10.0.0.5:11434"))
    const language = yield* provider.getLanguage(model)
    expect(openaiCompatibleBaseURL(language)).toBe("http://10.0.0.5:11434/v1")
  }),
)

// ─── regression ───────────────────────────────────────────────────────────────

it.instance(
  "disabled_providers excludes ollama",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("ollama")]).toBeUndefined()
  }),
  { config: { disabled_providers: ["ollama"] } },
)

it.instance("a real provider (anthropic via env) still resolves unchanged with ollama seeding active", () =>
  Effect.gen(function* () {
    yield* set("ANTHROPIC_API_KEY", "test-api-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic]).toBeDefined()
    expect(providers[ProviderV2.ID.anthropic].source).toBe("env")
    expect(providers[ProviderV2.ID.make("ollama")]).toBeDefined()
  }),
)

it.instance(
  "disabled_providers: getModel(ollama, qwen2.5) fails with ModelNotFoundError, is NOT synthesized as a bypass",
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const error = yield* provider
      .getModel(ProviderV2.ID.make("ollama"), ModelV2.ID.make("qwen2.5"))
      .pipe(Effect.flip)
    expect(error).toBeInstanceOf(Provider.ModelNotFoundError)
  }),
  { config: { disabled_providers: ["ollama"] } },
)

it.instance(
  "a user-configured provider.ollama baseURL (no models) is preserved: seeded curated models point at it",
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const model = yield* provider.getModel(ProviderV2.ID.make("ollama"), ModelV2.ID.make("qwen2.5"))
    const language = yield* provider.getLanguage(model)
    expect(openaiCompatibleBaseURL(language)).toBe("http://remote:11434/v1")

    // Arbitrary/dynamic tags synthesized on demand must also honor the
    // configured baseURL, not fall back to localhost.
    const arbitrary = yield* provider.getModel(ProviderV2.ID.make("ollama"), ModelV2.ID.make("mixtral"))
    const arbitraryLanguage = yield* provider.getLanguage(arbitrary)
    expect(openaiCompatibleBaseURL(arbitraryLanguage)).toBe("http://remote:11434/v1")
  }),
  {
    config: {
      provider: {
        ollama: {
          options: { baseURL: "http://remote:11434/v1" },
          models: {},
        },
      },
    },
  },
)

it.instance(
  "defaultModel never auto-picks the config-free ollama (config-provided providers keep priority)",
  Effect.gen(function* () {
    yield* set("ANTHROPIC_API_KEY", "test-api-key")
    const model = yield* Provider.use.defaultModel()
    expect(String(model.providerID)).not.toBe("ollama")
  }),
)
