import { describe, expect, test } from "bun:test"
import { createOpenAI } from "@ai-sdk/openai"
import { Effect } from "effect"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LLMRequestPrep } from "@/session/llm/request"
import { CodexAuthPlugin } from "@/plugin/openai/codex"
import type { Provider } from "@/provider/provider"
import type { Plugin } from "@/plugin"
import type { Auth } from "@/auth"
import type { Agent } from "@/agent/agent"
import type { RuntimeFlags } from "@/effect/runtime-flags"

const openaiModel: Provider.Model = {
  id: ModelV2.ID.make("gpt-5"),
  providerID: ProviderV2.ID.make("openai"),
  api: {
    id: "gpt-5",
    url: "https://api.openai.com/v1",
    npm: "@ai-sdk/openai",
  },
  name: "GPT-5",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128_000, input: 128_000, output: 32_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2025-01-01",
}

const gpt6AstraModel: Provider.Model = {
  id: ModelV2.ID.make("gpt-6-astra"),
  providerID: ProviderV2.ID.make("openai"),
  api: {
    id: "gpt-6-astra",
    url: "https://api.openai.com/v1",
    npm: "@ai-sdk/openai",
  },
  name: "GPT-6 Astra",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 1_050_000, input: 922_000, output: 128_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-03-01",
}

const anthropicModel: Provider.Model = {
  id: ModelV2.ID.make("claude-sonnet-4"),
  providerID: ProviderV2.ID.make("anthropic"),
  api: {
    id: "claude-sonnet-4",
    url: "https://api.anthropic.com/v1",
    npm: "@ai-sdk/anthropic",
  },
  name: "Claude Sonnet 4",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128_000, input: 128_000, output: 8_192 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2025-01-01",
}

function makePrepareInput(overrides: {
  providerID?: string
  model?: Provider.Model
  auth?: Auth.Info | undefined
  notificationOrigin?: boolean
  pluginHooks?: Record<string, unknown>
}) {
  const providerID = overrides.providerID ?? "openai"
  const model = overrides.model ?? openaiModel
  const hooks = overrides.pluginHooks ?? {}
  const hookCalls: { name: string; input: unknown }[] = []

  const plugin: Plugin.Interface = {
    trigger: ((name: string, input: unknown, output: unknown) =>
      Effect.gen(function* () {
        hookCalls.push({ name, input })
        const hook = hooks[name]
        if (typeof hook === "function") {
          yield* Effect.promise(() => Promise.resolve(hook(input, output)))
        }
        return output
      })) as Plugin.Interface["trigger"],
    list: () => Effect.succeed([]),
    init: () => Effect.void,
  }

  const user: SessionV1.User = {
    id: "msg_user_test" as SessionV1.User["id"],
    sessionID: "ses_notification_test" as SessionV1.User["sessionID"],
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: ProviderV2.ID.make(providerID), modelID: model.id },
  }

  const agent: Agent.Info = {
    name: "build",
    mode: "primary",
    options: {},
    permission: [],
  }

  const flags: RuntimeFlags.Info = {
    outputTokenMax: 32_000,
    client: "test",
  } as unknown as RuntimeFlags.Info

  return {
    input: {
      user,
      sessionID: "ses_notification_test",
      model,
      agent,
      system: [],
      messages: [{ role: "user" as const, content: "Hello" }],
      tools: {},
      provider: { id: ProviderV2.ID.make(providerID), options: {} } as unknown as Provider.Info,
      auth: overrides.auth,
      plugin,
      flags,
      isWorkflow: false,
      notificationOrigin: overrides.notificationOrigin,
    },
    hookCalls,
  }
}

async function serializeWithOpenAISDK(
  prepared: LLMRequestPrep.Prepared,
  modelID = "gpt-5",
): Promise<{ body: Record<string, unknown>; headers: HeadersInit | undefined }> {
  let capturedBody: Record<string, unknown> | undefined = undefined
  let capturedHeaders: HeadersInit | undefined = undefined

  const customFetch = async (_url: URL | RequestInfo, init?: RequestInit) => {
    capturedHeaders = init?.headers
    if (typeof init?.body === "string") {
      capturedBody = JSON.parse(init.body) as Record<string, unknown>
    }
    return new Response(
      JSON.stringify({
        id: "resp_test",
        output: [
          {
            id: "msg_test",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "ok", annotations: [] }],
          },
        ],
        status: "completed",
      }),
      { headers: { "content-type": "application/json" } },
    )
  }

  const openai = createOpenAI({
    apiKey: "dummy-key-for-test",
    fetch: customFetch as unknown as typeof fetch,
  })

  const model = openai.responses(modelID)
  await model.doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    maxOutputTokens: prepared.params.maxOutputTokens,
    temperature: prepared.params.temperature,
    topP: prepared.params.topP,
  })

  if (!capturedBody) throw new Error("OpenAI SDK did not serialize a request")
  return { body: capturedBody, headers: capturedHeaders }
}

describe("NOTIFICATION-OUTPUT-LIMIT", () => {
  const oauthAuth: Auth.Info = {
    type: "oauth",
    access: "test-access-token",
    refresh: "test-refresh-token",
    expires: Date.now() + 3600_000,
  }

  test("OpenAI OAuth: serialized max_output_tokens is absent on ordinary turns with Codex plugin", async () => {
    const codexHooks = (await CodexAuthPlugin(
      {} as unknown as Parameters<typeof CodexAuthPlugin>[0],
    )) as unknown as Record<string, unknown>
    const { input } = makePrepareInput({
      auth: oauthAuth,
      notificationOrigin: false,
      pluginHooks: codexHooks,
    })

    const prepared = await Effect.runPromise(LLMRequestPrep.prepare(input))
    expect(prepared.params.maxOutputTokens).toBeUndefined()

    const { body } = await serializeWithOpenAISDK(prepared)
    expect(body["max_output_tokens"]).toBeUndefined()
    expect("max_output_tokens" in body).toBe(false)
  })

  test("OpenAI OAuth: serialized max_output_tokens is absent on notificationOrigin turns", async () => {
    const codexHooks = (await CodexAuthPlugin(
      {} as unknown as Parameters<typeof CodexAuthPlugin>[0],
    )) as unknown as Record<string, unknown>
    const { input } = makePrepareInput({
      auth: oauthAuth,
      notificationOrigin: true,
      pluginHooks: codexHooks,
    })

    const prepared = await Effect.runPromise(LLMRequestPrep.prepare(input))
    expect(prepared.params.maxOutputTokens).toBeUndefined()

    const { body } = await serializeWithOpenAISDK(prepared)
    expect(body["max_output_tokens"]).toBeUndefined()
    expect("max_output_tokens" in body).toBe(false)
  })

  test("OpenAI OAuth (gpt-6-astra): serialized max_output_tokens is absent on notificationOrigin turns", async () => {
    const codexHooks = (await CodexAuthPlugin(
      {} as unknown as Parameters<typeof CodexAuthPlugin>[0],
    )) as unknown as Record<string, unknown>
    const { input } = makePrepareInput({
      model: gpt6AstraModel,
      auth: oauthAuth,
      notificationOrigin: true,
      pluginHooks: codexHooks,
    })

    const prepared = await Effect.runPromise(LLMRequestPrep.prepare(input))
    expect(prepared.params.maxOutputTokens).toBeUndefined()

    const { body } = await serializeWithOpenAISDK(prepared, "gpt-6-astra")
    expect(body["max_output_tokens"]).toBeUndefined()
    expect("max_output_tokens" in body).toBe(false)
  })

  test("OpenAI OAuth: serialized max_output_tokens is absent even if a plugin attempts to reintroduce the cap", async () => {
    const reintroducingPluginHooks = {
      "chat.params": async (_input: unknown, output: { maxOutputTokens?: number }) => {
        output.maxOutputTokens = 8192
      },
    }

    // Ordinary turn with reintroducing plugin hook
    const ordinary = makePrepareInput({
      auth: oauthAuth,
      notificationOrigin: false,
      pluginHooks: reintroducingPluginHooks,
    })
    const ordinaryPrepared = await Effect.runPromise(LLMRequestPrep.prepare(ordinary.input))
    expect(ordinaryPrepared.params.maxOutputTokens).toBeUndefined()
    const { body: ordinaryBody } = await serializeWithOpenAISDK(ordinaryPrepared)
    expect(ordinaryBody["max_output_tokens"]).toBeUndefined()
    expect("max_output_tokens" in ordinaryBody).toBe(false)

    // Notification turn with reintroducing plugin hook
    const notification = makePrepareInput({
      auth: oauthAuth,
      notificationOrigin: true,
      pluginHooks: reintroducingPluginHooks,
    })
    const notificationPrepared = await Effect.runPromise(LLMRequestPrep.prepare(notification.input))
    expect(notificationPrepared.params.maxOutputTokens).toBeUndefined()
    const { body: notificationBody } = await serializeWithOpenAISDK(notificationPrepared)
    expect(notificationBody["max_output_tokens"]).toBeUndefined()
    expect("max_output_tokens" in notificationBody).toBe(false)
  })

  test("non-OAuth OpenAI: preserves output limit in serialized body on notificationOrigin turns", async () => {
    const codexHooks = (await CodexAuthPlugin(
      {} as unknown as Parameters<typeof CodexAuthPlugin>[0],
    )) as unknown as Record<string, unknown>
    const { input } = makePrepareInput({
      auth: { type: "api", key: "test-openai-key" },
      notificationOrigin: true,
      pluginHooks: codexHooks,
    })

    const prepared = await Effect.runPromise(LLMRequestPrep.prepare(input))
    expect(prepared.params.maxOutputTokens).toBe(32_000)

    const { body } = await serializeWithOpenAISDK(prepared)
    expect(body["max_output_tokens"]).toBe(32_000)
  })

  test("another provider (Anthropic): preserves output limit on notificationOrigin turns", async () => {
    for (const auth of [{ type: "api" as const, key: "test-anthropic-key" }, oauthAuth]) {
      const { input } = makePrepareInput({
        providerID: "anthropic",
        model: anthropicModel,
        auth,
        notificationOrigin: true,
      })

      const prepared = await Effect.runPromise(LLMRequestPrep.prepare(input))
      expect(prepared.params.maxOutputTokens).toBe(8_192)
    }
  })

  test("asserts unrelated plugin hooks are skipped on notificationOrigin turns", async () => {
    let systemTransformCalled = false
    let chatHeadersCalled = false
    let chatParamsCalled = false

    const hooks = {
      "experimental.chat.system.transform": async () => {
        systemTransformCalled = true
      },
      "chat.headers": async (_input: unknown, output: { headers: Record<string, string> }) => {
        chatHeadersCalled = true
        output.headers["x-custom-test"] = "true"
      },
      "chat.params": async () => {
        chatParamsCalled = true
      },
    }

    const { input, hookCalls } = makePrepareInput({
      auth: oauthAuth,
      notificationOrigin: true,
      pluginHooks: hooks,
    })

    const prepared = await Effect.runPromise(LLMRequestPrep.prepare(input))

    expect(systemTransformCalled).toBe(false)
    expect(chatHeadersCalled).toBe(false)
    expect(chatParamsCalled).toBe(false)
    expect(hookCalls).toEqual([])
    expect((prepared.headers as Record<string, string | undefined>)["x-custom-test"]).toBeUndefined()
  })
})
