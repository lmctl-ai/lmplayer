import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import fs from "node:fs/promises"
import { cliIt } from "../lib/cli-process"

describe("opencode orchestrator commands (non-interactive subprocess)", () => {
  cliIt.concurrent(
    "orchestrator status supports -o text and json export",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        // Text file output
        const textOut = path.join(home, "orchestrator-status.txt")
        const resText = yield* opencode.spawn(["orchestrator", "status", "-o", textOut])
        opencode.expectExit(resText, 0)
        expect(resText.stderr).toContain("Wrote orchestrator status to")
        const textContent = yield* Effect.promise(() => fs.readFile(textOut, "utf-8"))
        expect(textContent).toContain("Containers")
        expect(textContent).toContain("Assignments")

        // JSON file output
        const jsonOut = path.join(home, "orchestrator-status.json")
        const resJson = yield* opencode.spawn(["orchestrator", "status", "--output", jsonOut, "--json"])
        opencode.expectExit(resJson, 0)
        expect(resJson.stderr).toContain("Wrote orchestrator status to")
        const jsonContent = yield* Effect.promise(() => fs.readFile(jsonOut, "utf-8"))
        const parsed = JSON.parse(jsonContent)
        expect(parsed).toHaveProperty("containers")
        expect(parsed).toHaveProperty("assignments")
      }),
    60_000,
  )

  cliIt.concurrent(
    "orchestrator assign supports -o file export and updates assignment map",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const assignOut = path.join(home, "assign.json")
        const resAssign = yield* opencode.spawn([
          "orchestrator",
          "assign",
          "--session",
          "sess-test-1",
          "--to",
          "http://localhost:9000",
          "-o",
          assignOut,
          "--json",
        ])
        opencode.expectExit(resAssign, 0)
        expect(resAssign.stderr).toContain("Wrote assignment to")
        const jsonContent = yield* Effect.promise(() => fs.readFile(assignOut, "utf-8"))
        const parsed = JSON.parse(jsonContent)
        expect(parsed.session).toBe("sess-test-1")
        expect(parsed.containerID).toBe("http://localhost:9000")
        expect(parsed.epoch).toBe(1)

        // Verify status reflects the assignment
        const statusRes = yield* opencode.spawn(["orchestrator", "status", "--json"])
        opencode.expectExit(statusRes, 0)
        const statusParsed = JSON.parse(statusRes.stdout)
        expect(statusParsed.assignments).toHaveProperty("sess-test-1")
        expect(statusParsed.assignments["sess-test-1"].containerID).toBe("http://localhost:9000")
      }),
    60_000,
  )
})
