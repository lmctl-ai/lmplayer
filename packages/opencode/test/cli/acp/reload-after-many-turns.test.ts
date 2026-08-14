import { describe, expect } from "bun:test"
import type { LoadSessionResponse, PromptResponse } from "@agentclientprotocol/sdk"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"
import { expectOk } from "./acp-test-client"
import { createAcpClient, initialize, newSession, verifierConfig } from "./helpers"

describe("opencode acp reload after many turns subprocess", () => {
  cliIt.live(
    "loads a session with many prior turns quickly and keeps prompting after reload",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient(
          { opencode },
          { OPENCODE_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) },
        )
        yield* initialize(acp)
        const session = yield* newSession(acp, home)

        // Build up real turn history - enough to exercise filterCompactedEffect's
        // pagination and loadSession's bounded replay against more than one page
        // of history, on the real spawned binary rather than a mock.
        for (let i = 0; i < 15; i++) {
          yield* llm.text(`reply ${i}`)
          expectOk(
            yield* acp.request<PromptResponse>("session/prompt", {
              sessionId: session.sessionId,
              prompt: [{ type: "text", text: `turn ${i}` }],
            }),
          )
        }

        // Simulate what `lmctl terminal` does on attach: session/load against a
        // session that already has real history, not a fresh one. This is the
        // exact path that used to fetch the entire history unbounded.
        const loadStarted = Date.now()
        const loaded = expectOk(
          yield* acp.request<LoadSessionResponse>("session/load", {
            cwd: home,
            sessionId: session.sessionId,
            mcpServers: [],
          }),
        )
        const loadMs = Date.now() - loadStarted
        expect(loaded).toBeDefined()
        expect(loadMs).toBeLessThan(15_000)

        // Confirm the session is still fully functional after reload, not just
        // that load itself returned - a prior version of the pagination fix
        // passed load quickly but pegged the CPU processing the next turn.
        yield* llm.text("post-reload reply")
        const prompted = expectOk(
          yield* acp.request<PromptResponse>("session/prompt", {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "one more after reload" }],
          }),
        )
        expect(prompted.stopReason).toBe("end_turn")
      }),
    120_000,
  )
})
