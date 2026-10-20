// Regression coverage for the session-import write path: an imported file's
// `info.summary.diffs` is attacker/export-file controlled and may exceed the
// cap SessionSummary.summarize() enforces live (SUMMARY_DIFFS_MAX_BYTES).
// cli/cmd/import.ts must bound it the same way instead of trusting its size,
// matching the write cap semantics message-level import already benefits from
// via the read-side strip (see session-diff-bounds.test.ts).
//
// Each case imports under a brand-new session ID (one character flipped from
// a real exported session's ID, keeping the same identifier shape): import's
// onConflictDoUpdate only refreshes project_id/directory/path/title on an
// existing row, so importing onto the already-existing source session would
// silently no-op the summary columns and prove nothing about the write cap.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { cliIt } from "../lib/cli-process"

function freshID(id: string) {
  const last = id.at(-1)!
  return id.slice(0, -1) + (last === "a" ? "b" : "a")
}

describe("session import bounds an oversized summary_diffs payload", () => {
  cliIt.concurrent(
    "caps an over-cap imported diff to []",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("hello world from import cap test")
        const runRes = yield* opencode.run("hello import cap over", { format: "json" })
        opencode.expectExit(runRes, 0)
        const sessionID = opencode.parseJsonEvents(runRes.stdout)[0]?.sessionID as string
        expect(sessionID).toBeDefined()

        const exportRes = yield* opencode.spawn(["session", "export", sessionID])
        opencode.expectExit(exportRes, 0)
        const exported = JSON.parse(exportRes.stdout)
        const importID = freshID(sessionID)
        exported.info.id = importID
        // Well past SUMMARY_DIFFS_MAX_BYTES (1MB).
        exported.info.summary = {
          additions: 1,
          deletions: 0,
          files: 1,
          diffs: [{ file: "big.txt", additions: 1, deletions: 0, status: "modified", patch: "x".repeat(2_000_000) }],
        }
        const overCapFile = path.join(home, "over-cap-session.json")
        yield* Effect.promise(() => fs.writeFile(overCapFile, JSON.stringify(exported)))

        const overCapImport = yield* opencode.spawn(["session", "import", overCapFile, "--json"])
        opencode.expectExit(overCapImport, 0)
        const overCapExport = yield* opencode.spawn(["session", "export", importID])
        opencode.expectExit(overCapExport, 0)
        const overCapResult = JSON.parse(overCapExport.stdout)
        expect(overCapResult.info.summary.diffs).toEqual([])
      }),
    60_000,
  )

  cliIt.concurrent(
    "preserves an in-cap imported diff",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("hello world from import cap test")
        const runRes = yield* opencode.run("hello import cap under", { format: "json" })
        opencode.expectExit(runRes, 0)
        const sessionID = opencode.parseJsonEvents(runRes.stdout)[0]?.sessionID as string
        expect(sessionID).toBeDefined()

        const exportRes = yield* opencode.spawn(["session", "export", sessionID])
        opencode.expectExit(exportRes, 0)
        const exported = JSON.parse(exportRes.stdout)
        const importID = freshID(sessionID)
        exported.info.id = importID
        exported.info.summary = {
          additions: 1,
          deletions: 0,
          files: 1,
          diffs: [{ file: "small.txt", additions: 1, deletions: 0, status: "modified", patch: "hello" }],
        }
        const underCapFile = path.join(home, "under-cap-session.json")
        yield* Effect.promise(() => fs.writeFile(underCapFile, JSON.stringify(exported)))

        const underCapImport = yield* opencode.spawn(["session", "import", underCapFile, "--json"])
        opencode.expectExit(underCapImport, 0)
        const underCapExport = yield* opencode.spawn(["session", "export", importID])
        opencode.expectExit(underCapExport, 0)
        const underCapResult = JSON.parse(underCapExport.stdout)
        expect(underCapResult.info.summary.diffs).toEqual([
          { file: "small.txt", additions: 1, deletions: 0, status: "modified", patch: "hello" },
        ])
      }),
    60_000,
  )
})
