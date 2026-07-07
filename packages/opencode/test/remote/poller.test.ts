import { describe, expect } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Session as SessionNs } from "@/session/session"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { HttpServer } from "effect/unstable/http"
import { FetchHttpClient } from "effect/unstable/http"
import { httpApiLayer } from "../server/httpapi-layer"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { tmpdirScoped } from "../fixture/fixture"
import { RemoteChannel } from "../../src/remote/channel"
import { RemotePoller } from "../../src/remote/poller"

const noopBootstrapLayer = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const appLayer = AppNodeBuilder.build(
  LayerNode.group([FSUtil.node, CrossSpawnSpawner.node, InstanceStore.node, Database.node, SessionNs.node]),
  [[InstanceStore.bootstrapNode, noopBootstrapLayer]],
)
const it = testEffect(Layer.mergeAll(appLayer, httpApiLayer))

type Sdk = ReturnType<typeof createOpencodeClient>

function client(directory: string) {
  return HttpServer.HttpServer.use((server) =>
    Effect.sync(() => {
      const baseUrl = HttpServer.formatAddress(server.address)
      const fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
        const source = request instanceof Request ? request : new Request(request, init)
        const url = new URL(source.url)
        return globalThis.fetch(new Request(new URL(`${url.pathname}${url.search}`, baseUrl), source))
      }) as typeof globalThis.fetch
      return createOpencodeClient({ baseUrl: "http://localhost", directory, fetch })
    }),
  )
}

function withFakeLlm<A, E>(run: (input: { sdk: Sdk; llm: TestLLMServer["Service"] }) => Effect.Effect<A, E>) {
  return Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const directory = yield* tmpdirScoped({ config: testProviderConfig(llm.url) })
    const sdk = yield* client(directory)
    return yield* run({ sdk, llm })
  }).pipe(Effect.provide(TestLLMServer.layer))
}

it.live(
  "drains a stub instruction through a real session prompt and posts the reply back",
  withFakeLlm(({ sdk, llm }) =>
    Effect.gen(function* () {
      yield* llm.text("ACK: instruction handled")

      const session = yield* Effect.promise(() =>
        sdk.session.create({
          title: "remote-poll",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        }),
      )
      const sessionID = String(session.data?.id)

      const mailbox = RemoteChannel.stub()
      mailbox.enqueue({ id: "i1", seq: 1, text: "do the thing" })

      const submit: RemotePoller.Submit = (text) =>
        Effect.tryPromise(() =>
          sdk.session
            .prompt(
              {
                sessionID,
                agent: "build",
                model: { providerID: "test", modelID: "test-model" },
                parts: [{ type: "text", text }],
              },
              { throwOnError: true },
            )
            .then((result) => result.data ?? result),
        )

      const after = Ref.makeUnsafe(0)
      const processed = yield* RemotePoller.drainOnce({
        channel: mailbox.channel,
        submit,
        detail: "full",
        after,
      })

      const posted = mailbox.posted()
      const cursor = yield* Ref.get(after)
      const inputs = yield* llm.inputs

      expect(processed).toBe(1)
      expect(posted.length).toBe(1)
      expect(posted[0]?.instructionId).toBe("i1")
      expect(posted[0]?.payload.text).toContain("ACK: instruction handled")
      expect(cursor).toBe(1)
      expect(JSON.stringify(inputs[0])).toContain("do the thing")
    }),
  ),
)

it.live(
  "processes the second instruction and advances the cursor when the first submit fails",
  Effect.gen(function* () {
    const mailbox = RemoteChannel.stub()
    mailbox.enqueue({ id: "i1", seq: 1, text: "poison" })
    mailbox.enqueue({ id: "i2", seq: 2, text: "do the thing" })

    const submit: RemotePoller.Submit = (text) =>
      text === "poison" ? Effect.fail(new Error("simulated turn failure")) : Effect.succeed({ parts: [{ type: "text", text: "ACK: second" }] })

    const after = Ref.makeUnsafe(0)
    const processed = yield* RemotePoller.drainOnce({
      channel: mailbox.channel,
      submit,
      detail: "full",
      after,
    })

    const posted = mailbox.posted()
    const cursor = yield* Ref.get(after)

    expect(processed).toBe(2)
    expect(posted.length).toBe(2)
    expect(posted[0]?.instructionId).toBe("i1")
    expect(posted[0]?.payload.text).toContain("ERROR")
    expect(posted[0]?.payload.text).toContain("simulated turn failure")
    expect(posted[1]?.instructionId).toBe("i2")
    expect(posted[1]?.payload.text).toContain("ACK: second")
    expect(cursor).toBe(2)
  }),
)

describe("httpMailbox URL join", () => {
  it.effect(
    "derives /response correctly from a base URL with a trailing slash and an existing query string",
    Effect.gen(function* () {
      const seen: string[] = []
      const server = Bun.serve({
        port: 0,
        fetch(request) {
          seen.push(request.url)
          return new Response(JSON.stringify({ instructions: [] }), { status: 200 })
        },
      })

      try {
        const base = `http://localhost:${server.port}/box/?tenant=a`
        const channel = RemoteChannel.httpMailbox({ url: base })

        yield* channel.poll(0).pipe(Effect.provide(FetchHttpClient.layer))
        yield* channel.respond("i1", { detail: "full", text: "ok" }).pipe(Effect.provide(FetchHttpClient.layer))

        expect(seen.length).toBe(2)
        const pollUrl = new URL(seen[0]!)
        expect(pollUrl.pathname).toBe("/box/")
        expect(pollUrl.searchParams.get("tenant")).toBe("a")
        expect(pollUrl.searchParams.get("after")).toBe("0")

        const respondUrl = new URL(seen[1]!)
        expect(respondUrl.pathname).toBe("/box/response")
        expect(respondUrl.searchParams.get("tenant")).toBe("a")
      } finally {
        server.stop(true)
      }
    }),
  )
})

describe("formatReply", () => {
  const reply = { parts: [{ type: "text", text: "hello world" }] }

  it.effect(
    "returns full text unchanged for 'full' and 'delta'",
    Effect.sync(() => {
      expect(RemotePoller.formatReply(reply, "full")).toBe("hello world")
      expect(RemotePoller.formatReply(reply, "delta")).toBe("hello world")
    }),
  )

  it.effect(
    "truncates long text at 280 chars for 'summary'",
    Effect.sync(() => {
      const long = { parts: [{ type: "text", text: "x".repeat(300) }] }
      const result = RemotePoller.formatReply(long, "summary")
      expect(result.length).toBe(281)
      expect(result.endsWith("…")).toBe(true)
    }),
  )
})
