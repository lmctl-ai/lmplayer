// Subprocess integration tests for the cross-container / refresh features:
//
//   TEST 1 — graceful drain-then-exit (POST /shutdown). Proves that a drain
//            rejects NEW work with 503 while letting the single in-flight run
//            FINISH NORMALLY, then exits the process.
//
//   TEST 2 — session handover across TWO independent serve processes, each with
//            its own data dir and its own mock LLM. Export a session bundle from
//            A over HTTP and import it onto B, then prove B can continue it.
//
// Both run the REAL `opencode serve` binary wired to the in-process
// TestLLMServer mock (no real provider, instant responses). The mock primitives
// used here are:
//   - llm.hold(text, gate) : queue a reply that streams its role head, then
//                            BLOCKS on `gate` (a native Promise) before emitting
//                            the text + stop. This keeps a run deterministically
//                            in-flight with zero real latency — releasing `gate`
//                            completes it.
//   - llm.wait(n)          : resolve once the mock has received `n` HTTP calls —
//                            a published readiness signal (no sleep races).
//   - llm.text(v)          : queue a plain text reply (FIFO; title requests are
//                            auto-answered and do NOT consume the queue).
import { describe, expect } from "bun:test"
import { Effect, Fiber } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { cliIt, testModelID, withCliFixture } from "../../lib/cli-process"
import { it } from "../../lib/effect"

const [providerID, modelID] = testModelID.split("/")
const model = { providerID, modelID }

// Create a session over HTTP and return its id.
const createSession = (client: HttpClient.HttpClient, url: string) =>
  Effect.gen(function* () {
    const res = yield* client.execute(HttpClientRequest.post(`${url}/session`))
    expect(res.status).toBe(200)
    const body = (yield* res.json) as { id: string }
    return body.id
  })

// Synchronous prompt: POST /session/:id/message. Returns the raw response so the
// caller can assert status (200 normal, 503 during drain).
const promptSync = (client: HttpClient.HttpClient, url: string, sessionID: string, text: string) =>
  client.execute(
    HttpClientRequest.post(`${url}/session/${sessionID}/message`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ model, parts: [{ type: "text", text }] }),
    ),
  )

describe("opencode refresh/drain (subprocess)", () => {
  // TEST 1 — PRIMARY. Hold the LLM so a prompt stays in-flight, then drain.
  cliIt.live(
    "drain rejects new work with 503, lets the in-flight run finish, then exits",
    ({ opencode, llm }) =>
      Effect.gen(function* () {
        const server = yield* opencode.serve()
        const client = yield* HttpClient.HttpClient

        const sessionID = yield* createSession(client, server.url)

        // Queue a held reply: the run will stream its role head then block on the
        // gate, keeping it in-flight (holding the global execution permit) with no
        // real latency.
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
          release = resolve
        })
        yield* llm.hold("in-flight complete", gate)

        // Start the in-flight prompt in the background. It will NOT return until
        // we release the gate.
        const inflight = yield* Effect.forkScoped(promptSync(client, server.url, sessionID, "hold please"))

        // Deterministically wait until the mock has actually received the call —
        // the run is now in-flight and holding the permit.
        yield* llm.wait(1)

        // Request graceful shutdown. Responds immediately with { draining: true }
        // and flips the draining flag synchronously (new runs now 503).
        const shutdownRes = yield* client.execute(HttpClientRequest.post(`${server.url}/shutdown`))
        expect(shutdownRes.status).toBe(200)
        expect(yield* shutdownRes.json).toEqual({ draining: true })

        // A NEW synchronous prompt during drain must be rejected with 503.
        const rejectedSync = yield* promptSync(client, server.url, sessionID, "too late")
        expect(rejectedSync.status).toBe(503)

        // prompt_async during drain must ALSO be rejected with 503 (not a false 204).
        const rejectedAsync = yield* client.execute(
          HttpClientRequest.post(`${server.url}/session/${sessionID}/prompt_async`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ model, parts: [{ type: "text", text: "too late async" }] }),
          ),
        )
        expect(rejectedAsync.status).toBe(503)

        // Release the held LLM response — the in-flight run completes NORMALLY.
        release()
        const completed = yield* Fiber.join(inflight)
        expect(completed.status).toBe(200)
        const message = (yield* completed.json) as { info: { role: string }; parts: unknown[] }
        // Assistant message came back without an abort error.
        expect(message.info.role).toBe("assistant")

        // ...and THEN the process drains the permit and exits. The graceful path
        // sleeps ~100ms before force-exit, so this resolves shortly after.
        const code = yield* Effect.promise(() => server.exited)
        expect(code).toBe(0)
      }),
    60_000,
  )

  // TEST 2 — SECONDARY. Two fully independent serve processes (separate data
  // dirs + separate mock LLMs via nested fixtures). Hand a session A -> B.
  it.live(
    "handover: export a session from A and import + continue it on B",
    () =>
      withCliFixture((a) =>
        withCliFixture((b) =>
          Effect.gen(function* () {
            const serverA = yield* a.opencode.serve()
            const serverB = yield* b.opencode.serve()
            const client = yield* HttpClient.HttpClient

            // Establish state on A: create a session and run one prompt.
            const sessionID = yield* createSession(client, serverA.url)
            yield* a.llm.text("hello from A")
            const promptA = yield* promptSync(client, serverA.url, sessionID, "say hi")
            expect(promptA.status).toBe(200)

            // Export a portable bundle (tail of the conversation) from A.
            const exportRes = yield* client.execute(
              HttpClientRequest.get(`${serverA.url}/session/${sessionID}/export?tail=10`),
            )
            expect(exportRes.status).toBe(200)
            const bundle = (yield* exportRes.json) as { session: { id: string }; tail: unknown[] }
            expect(bundle.session.id).toBe(sessionID)
            expect(bundle.tail.length).toBeGreaterThan(0)

            // Import the bundle onto B (separate process + data dir).
            const importRes = yield* client.execute(
              HttpClientRequest.post(`${serverB.url}/session/import`).pipe(HttpClientRequest.bodyJsonUnsafe(bundle)),
            )
            expect(importRes.status).toBe(200)
            const imported = (yield* importRes.json) as { sessionID: string; imported: boolean; messageCount: number }
            expect(imported.imported).toBe(true)
            expect(imported.sessionID).toBe(sessionID)
            expect(imported.messageCount).toBe(bundle.tail.length)

            // B now has the session with the imported tail.
            const messagesRes = yield* client.execute(
              HttpClientRequest.get(`${serverB.url}/session/${sessionID}/message`),
            )
            expect(messagesRes.status).toBe(200)
            const messages = (yield* messagesRes.json) as unknown[]
            expect(messages.length).toBe(bundle.tail.length)

            // A follow-up prompt on B continues the imported session with a mock reply.
            yield* b.llm.text("continued on B")
            const followUp = yield* promptSync(client, serverB.url, sessionID, "continue")
            expect(followUp.status).toBe(200)
            const followUpMsg = (yield* followUp.json) as { info: { role: string } }
            expect(followUpMsg.info.role).toBe("assistant")

            // Confirm both processes only ever talked to their OWN mock (no real provider).
            expect(yield* a.llm.calls).toBeGreaterThan(0)
            expect(yield* b.llm.calls).toBeGreaterThan(0)
          }),
        ),
      ),
    90_000,
  )
})
