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
        expect(showWithMemData.status).toBeDefined()
        expect(showWithMemData.status.type).toBe("idle")

        // 5. Test session status command
        // 5a. Non-existent session status fails cleanly
        const statusNotFoundRes = yield* opencode.spawn(["session", "status", notFound])
        opencode.expectExit(statusNotFoundRes, 1)
        expect(statusNotFoundRes.stderr).toContain(`Session not found: ${notFound}`)

        // 5b. All sessions status (human and JSON)
        const statusAllRes = yield* opencode.spawn(["session", "status"])
        opencode.expectExit(statusAllRes, 0)
        expect(statusAllRes.stderr).toBeDefined()

        const statusAllJsonRes = yield* opencode.spawn(["session", "status", "--json"])
        opencode.expectExit(statusAllJsonRes, 0)
        const statusAllData = JSON.parse(statusAllJsonRes.stdout)
        expect(typeof statusAllData).toBe("object")

        // 5c. Specific session status (human and JSON)
        const statusSingleRes = yield* opencode.spawn(["session", "status", sessionID])
        opencode.expectExit(statusSingleRes, 0)
        expect(statusSingleRes.stderr).toContain(`Session ${sessionID}: idle`)

        const statusSingleJsonRes = yield* opencode.spawn(["session", "status", sessionID, "--json"])
        opencode.expectExit(statusSingleJsonRes, 0)
        const statusSingleData = JSON.parse(statusSingleJsonRes.stdout)
        expect(statusSingleData.id).toBe(sessionID)
        expect(statusSingleData.status.type).toBe("idle")
      }),
    60_000,
  )
})
