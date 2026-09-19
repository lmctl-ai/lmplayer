import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ExportCommand, runExport } from "../../src/cli/cmd/export"
import { ImportCommand, runImport } from "../../src/cli/cmd/import"
import { cliIt } from "../lib/cli-process"
import yargs, { type Argv } from "yargs"

describe("export and import command definitions & builders", () => {
  test("ExportCommand registers export and options", () => {
    expect(ExportCommand.command).toBe("export [sessionID]")
    const builder = ExportCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.output).toBeDefined()
    expect(options.key.sanitize).toBeDefined()
    expect(options.key.json).toBeDefined()
  })

  test("ImportCommand registers import and options", () => {
    expect(ImportCommand.command).toBe("import <file>")
    const builder = ImportCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.title).toBeDefined()
    expect(options.key.json).toBeDefined()
  })
})

describe("session export and import (CLI)", () => {
  cliIt.concurrent(
    "fails cleanly on invalid inputs and non-existent targets",
    ({ opencode }) =>
      Effect.gen(function* () {
        // Export non-existent session
        const exportRes = yield* opencode.spawn(["session", "export", "ses_missing123"])
        opencode.expectExit(exportRes, 1)
        expect(exportRes.stderr).toContain("Session not found: ses_missing123")

        // Import non-existent file
        const importRes = yield* opencode.spawn(["session", "import", "non_existent_file.json"])
        opencode.expectExit(importRes, 1)
        expect(importRes.stderr).toContain("File not found: non_existent_file.json")

        // Import invalid URL format
        const importUrlRes = yield* opencode.spawn(["session", "import", "https://example.com/invalid"])
        opencode.expectExit(importUrlRes, 1)
        expect(importUrlRes.stderr).toContain("Invalid URL format")
      }),
    60_000,
  )

  cliIt.concurrent(
    "exports session to file with and without --json, and imports it with custom title",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("hello world from export test")
        const runRes = yield* opencode.run("hello export", { format: "json" })
        opencode.expectExit(runRes, 0)
        const events = opencode.parseJsonEvents(runRes.stdout)
        const sessionID = events[0]?.sessionID as string
        expect(sessionID).toBeDefined()

        // 1. Export session to file using -o
        const exportRes = yield* opencode.spawn(["session", "export", sessionID, "-o", "session-backup.json"])
        opencode.expectExit(exportRes, 0)
        expect(exportRes.stdout).toContain(`Exported session ${sessionID} to`)

        // 2. Export session with --json
        const exportJsonRes = yield* opencode.spawn([
          "session",
          "export",
          sessionID,
          "--output",
          "session-backup-json.json",
          "--json",
        ])
        opencode.expectExit(exportJsonRes, 0)
        const exportSummary = JSON.parse(exportJsonRes.stdout)
        expect(exportSummary.ok).toBe(true)
        expect(exportSummary.session_id).toBe(sessionID)
        expect(exportSummary.messages).toBeGreaterThan(0)
        expect(exportSummary.file).toContain("session-backup-json.json")

        // 3. Export session to stdout (clean JSON)
        const exportStdoutRes = yield* opencode.spawn(["session", "export", sessionID])
        opencode.expectExit(exportStdoutRes, 0)
        const parsedExport = JSON.parse(exportStdoutRes.stdout)
        expect(parsedExport.info.id).toBe(sessionID)
        expect(Array.isArray(parsedExport.messages)).toBe(true)

        // 4. Import exported file with --title and --json
        const importRes = yield* opencode.spawn([
          "session",
          "import",
          "session-backup.json",
          "--title",
          "Restored Session Title",
          "--json",
        ])
        opencode.expectExit(importRes, 0)
        const importData = JSON.parse(importRes.stdout)
        expect(importData.ok).toBe(true)
        expect(importData.id).toBe(sessionID)
        expect(importData.title).toBe("Restored Session Title")
        expect(importData.messages).toBeGreaterThan(0)

        // 5. Verify session list shows the updated title
        const lsRes = yield* opencode.spawn(["session", "ls", "--json"])
        opencode.expectExit(lsRes, 0)
        const lsData = JSON.parse(lsRes.stdout)
        const imported = lsData.find((s: any) => s.id === sessionID)
        expect(imported).toBeDefined()
        expect(imported.title).toBe("Restored Session Title")

        // 6. Verify session report works on imported session
        const reportRes = yield* opencode.spawn(["session", "report", sessionID, "--json"])
        opencode.expectExit(reportRes, 0)
        const reportData = JSON.parse(reportRes.stdout)
        expect(reportData.sessionID).toBe(sessionID)
      }),
    60_000,
  )
})
