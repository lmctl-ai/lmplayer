import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"

describe("opencode session commands (CLI)", () => {
  cliIt.concurrent(
    "fails cleanly when targeting a non-existent session",
    ({ opencode }) =>
      Effect.gen(function* () {
        const notFound = "ses_nonexistent123"

        const renameRes = yield* opencode.spawn(["session", "rename", notFound, "New Title"])
        opencode.expectExit(renameRes, 1)
        expect(renameRes.stderr).toContain(`Session not found: ${notFound}`)

        const forkRes = yield* opencode.spawn(["session", "fork", notFound])
        opencode.expectExit(forkRes, 1)
        expect(forkRes.stderr).toContain(`Session not found: ${notFound}`)

        const shareRes = yield* opencode.spawn(["session", "share", notFound])
        opencode.expectExit(shareRes, 1)
        expect(shareRes.stderr).toContain(`Session not found: ${notFound}`)

        const unshareRes = yield* opencode.spawn(["session", "unshare", notFound])
        opencode.expectExit(unshareRes, 1)
        expect(unshareRes.stderr).toContain(`Session not found: ${notFound}`)

        const compactRes = yield* opencode.spawn(["session", "compact", notFound])
        opencode.expectExit(compactRes, 1)
        expect(compactRes.stderr).toContain(`Session not found: ${notFound}`)

        const jobsRes = yield* opencode.spawn(["session", "jobs", notFound])
        opencode.expectExit(jobsRes, 1)
        expect(jobsRes.stderr).toContain(`Session not found: ${notFound}`)

        const cronsRes = yield* opencode.spawn(["session", "crons", notFound])
        opencode.expectExit(cronsRes, 1)
        expect(cronsRes.stderr).toContain(`Session not found: ${notFound}`)

        const todoRes = yield* opencode.spawn(["session", "todo", notFound])
        opencode.expectExit(todoRes, 1)
        expect(todoRes.stderr).toContain(`Session not found: ${notFound}`)

        const diffRes = yield* opencode.spawn(["session", "diff", notFound])
        opencode.expectExit(diffRes, 1)
        expect(diffRes.stderr).toContain(`Session not found: ${notFound}`)

        const exportRes = yield* opencode.spawn(["session", "export", notFound])
        opencode.expectExit(exportRes, 1)
        expect(exportRes.stderr).toContain(`Session not found: ${notFound}`)
      }),
    60_000,
  )

  cliIt.concurrent(
    "renames, forks, and lists sessions successfully",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("hello from llm")
        const runRes = yield* opencode.run("say hi", { format: "json" })
        opencode.expectExit(runRes, 0)
        const events = opencode.parseJsonEvents(runRes.stdout)
        const sessionID = events[0]?.sessionID as string
        expect(sessionID).toBeDefined()

        // 1. Rename session
        const renameRes = yield* opencode.spawn(["session", "rename", sessionID, "Renamed Session Title"])
        opencode.expectExit(renameRes, 0)
        expect(renameRes.stderr).toContain(`Session ${sessionID} renamed to "Renamed Session Title"`)

        // 2. Rename session with --json
        const renameJsonRes = yield* opencode.spawn(["session", "rename", sessionID, "Second Title", "--json"])
        opencode.expectExit(renameJsonRes, 0)
        const renameData = JSON.parse(renameJsonRes.stdout)
        expect(renameData.id).toBe(sessionID)
        expect(renameData.title).toBe("Second Title")

        // 3. Fork session
        const forkRes = yield* opencode.spawn(["session", "fork", sessionID])
        opencode.expectExit(forkRes, 0)
        expect(forkRes.stderr).toContain(`Forked session ${sessionID} to `)

        // 4. Fork session with --json
        const forkJsonRes = yield* opencode.spawn(["session", "fork", sessionID, "--json"])
        opencode.expectExit(forkJsonRes, 0)
        const forkData = JSON.parse(forkJsonRes.stdout)
        expect(forkData.id).toBeDefined()
        expect(forkData.id).not.toBe(sessionID)
        expect(forkData.title).toContain("Second Title (fork")

        // 5. Verify session list shows the sessions
        const lsRes = yield* opencode.spawn(["session", "ls", "--json"])
        opencode.expectExit(lsRes, 0)
        const lsData = JSON.parse(lsRes.stdout)
        expect(lsData.some((s: any) => s.id === sessionID && s.title === "Second Title")).toBe(true)
        expect(lsData.some((s: any) => s.id === forkData.id)).toBe(true)

        // 5a. Verify limit/max-count flag
        const limitRes = yield* opencode.spawn(["session", "ls", "--limit", "1", "--json"])
        opencode.expectExit(limitRes, 0)
        const limitData = JSON.parse(limitRes.stdout)
        expect(limitData.length).toBe(1)

        // 5b. Verify search flag
        const searchRes = yield* opencode.spawn(["session", "ls", "--search", "Second Title", "--json"])
        opencode.expectExit(searchRes, 0)
        const searchData = JSON.parse(searchRes.stdout)
        expect(searchData.some((s: any) => s.id === sessionID)).toBe(true)

        // 5c. Verify text output format
        const textRes = yield* opencode.spawn(["session", "ls", "-n", "1"])
        opencode.expectExit(textRes, 0)
        expect(textRes.stderr).toContain(limitData[0].id)

        // 6. Delete the forked session
        const deleteRes = yield* opencode.spawn(["session", "delete", forkData.id])
        opencode.expectExit(deleteRes, 0)
        expect(deleteRes.stderr).toContain(`Session ${forkData.id} deleted`)

        // 7. Verify session list no longer shows the deleted session
        const afterDeleteRes = yield* opencode.spawn(["session", "ls", "--json"])
        opencode.expectExit(afterDeleteRes, 0)
        const afterDeleteData = JSON.parse(afterDeleteRes.stdout)
        expect(afterDeleteData.some((s: any) => s.id === forkData.id)).toBe(false)
        expect(afterDeleteData.some((s: any) => s.id === sessionID)).toBe(true)

        // 8. Compact the session
        yield* llm.text("compacted summary")
        const compactRes = yield* opencode.spawn([
          "session",
          "compact",
          sessionID,
          "--model",
          "test/test-model",
          "--json",
        ])
        opencode.expectExit(compactRes, 0)
        const compactData = JSON.parse(compactRes.stdout)
        expect(compactData.id).toBe(sessionID)
        expect(compactData.compacted).toBe(true)

        // 9. Inspect session jobs
        const jobsRes = yield* opencode.spawn(["session", "jobs", sessionID])
        opencode.expectExit(jobsRes, 0)
        expect(jobsRes.stdout).toContain(`No background jobs found for session ${sessionID}`)

        // 10. Inspect session jobs with --json
        const jobsJsonRes = yield* opencode.spawn(["session", "jobs", sessionID, "--json"])
        opencode.expectExit(jobsJsonRes, 0)
        const jobsData = JSON.parse(jobsJsonRes.stdout)
        expect(Array.isArray(jobsData)).toBe(true)
        expect(jobsData.length).toBe(0)
      }),
    60_000,
  )
})
