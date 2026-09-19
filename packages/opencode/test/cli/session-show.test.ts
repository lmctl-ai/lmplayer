import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"

describe("opencode session show / get (CLI)", () => {
  cliIt.concurrent(
    "shows session metadata, message counts, tokens, and cost",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        const notFound = "ses_nonexistent999"
        const notFoundRes = yield* opencode.spawn(["session", "show", notFound])
        opencode.expectExit(notFoundRes, 1)
        expect(notFoundRes.stderr).toContain(`Session not found: ${notFound}`)

        const notFoundGet = yield* opencode.spawn(["session", "get", notFound])
        opencode.expectExit(notFoundGet, 1)
        expect(notFoundGet.stderr).toContain(`Session not found: ${notFound}`)

        yield* llm.text("hello world from llm")
        const runRes = yield* opencode.run("say test message", { format: "json" })
        opencode.expectExit(runRes, 0)
        const events = opencode.parseJsonEvents(runRes.stdout)
        const sessionID = events[0]?.sessionID as string
        expect(sessionID).toBeDefined()

        // 1. Text output format for session show
        const showRes = yield* opencode.spawn(["session", "show", sessionID])
        opencode.expectExit(showRes, 0)
        expect(showRes.stderr).toContain(sessionID)
        expect(showRes.stderr).toContain("Messages:")
        expect(showRes.stderr).toContain("Tokens:")

        // 2. JSON output format for session show
        const showJsonRes = yield* opencode.spawn(["session", "show", sessionID, "--json"])
        opencode.expectExit(showJsonRes, 0)
        const showData = JSON.parse(showJsonRes.stdout)
        expect(showData.id).toBe(sessionID)
        expect(showData.title).toBeDefined()
        expect(showData.cost).toBeDefined()
        expect(showData.tokens).toBeDefined()
        expect(showData.tokens.input).toBeGreaterThanOrEqual(0)
        expect(showData.messages).toBeGreaterThan(0)
        expect(showData.turns.user).toBeGreaterThan(0)
        expect(showData.turns.assistant).toBeGreaterThan(0)

        // 3. Alias `get` works identically
        const getJsonRes = yield* opencode.spawn(["session", "get", sessionID, "--json"])
        opencode.expectExit(getJsonRes, 0)
        const getData = JSON.parse(getJsonRes.stdout)
        expect(getData.id).toBe(sessionID)
        expect(getData.title).toBe(showData.title)

        // 4. Record durable memory and verify session show includes memory info
        const memRes = yield* opencode.spawn([
          "session",
          "memory",
          sessionID,
          "--write",
          "Important project note for test session",
          "--json",
        ])
        opencode.expectExit(memRes, 0)

        const showWithMemRes = yield* opencode.spawn(["session", "show", sessionID, "--json"])
        opencode.expectExit(showWithMemRes, 0)
        const showWithMemData = JSON.parse(showWithMemRes.stdout)
        expect(showWithMemData.memory.exists).toBe(true)
        expect(showWithMemData.memory.bytes).toBeGreaterThan(0)
      }),
    60_000,
  )
})
