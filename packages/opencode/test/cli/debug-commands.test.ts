import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import fs from "node:fs/promises"
import { cliIt } from "../lib/cli-process"

describe("opencode debug commands (non-interactive subprocess)", () => {
  cliIt.concurrent(
    "debug paths outputs JSON and supports -o / --output export",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        // stdout JSON
        const resJson = yield* opencode.spawn(["debug", "paths", "--json"])
        opencode.expectExit(resJson, 0)
        const parsed = JSON.parse(resJson.stdout)
        expect(parsed).toHaveProperty("data")
        expect(parsed).toHaveProperty("config")
        expect(parsed).toHaveProperty("state")

        // File output (text)
        const textOut = path.join(home, "paths.txt")
        const resText = yield* opencode.spawn(["debug", "paths", "-o", textOut])
        opencode.expectExit(resText, 0)
        expect(resText.stderr).toContain("Wrote paths to")
        const textContent = yield* Effect.promise(() => fs.readFile(textOut, "utf-8"))
        expect(textContent).toContain("data")
        expect(textContent).toContain("config")

        // File output (JSON)
        const jsonOut = path.join(home, "paths.json")
        const resJsonOut = yield* opencode.spawn(["debug", "paths", "--output", jsonOut, "--json"])
        opencode.expectExit(resJsonOut, 0)
        expect(resJsonOut.stderr).toContain("Wrote paths to")
        const jsonContent = yield* Effect.promise(() => fs.readFile(jsonOut, "utf-8"))
        const parsedFileJson = JSON.parse(jsonContent)
        expect(parsedFileJson).toHaveProperty("data")
        expect(parsedFileJson).toHaveProperty("config")
      }),
    60_000,
  )

  cliIt.concurrent(
    "debug info outputs JSON and supports -o / --output export",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        // stdout JSON
        const resJson = yield* opencode.spawn(["debug", "info", "--json"])
        opencode.expectExit(resJson, 0)
        const parsed = JSON.parse(resJson.stdout)
        expect(parsed).toHaveProperty("version")
        expect(parsed).toHaveProperty("os")
        expect(parsed).toHaveProperty("plugins")

        // File output (text)
        const textOut = path.join(home, "info.txt")
        const resText = yield* opencode.spawn(["debug", "info", "-o", textOut])
        opencode.expectExit(resText, 0)
        expect(resText.stderr).toContain("Wrote debug info to")
        const textContent = yield* Effect.promise(() => fs.readFile(textOut, "utf-8"))
        expect(textContent).toContain("opencode version:")
        expect(textContent).toContain("os:")

        // File output (JSON)
        const jsonOut = path.join(home, "info.json")
        const resJsonOut = yield* opencode.spawn(["debug", "info", "--output", jsonOut, "--json"])
        opencode.expectExit(resJsonOut, 0)
        expect(resJsonOut.stderr).toContain("Wrote debug info to")
        const jsonContent = yield* Effect.promise(() => fs.readFile(jsonOut, "utf-8"))
        const parsedFileJson = JSON.parse(jsonContent)
        expect(parsedFileJson).toHaveProperty("version")
        expect(parsedFileJson).toHaveProperty("os")
      }),
    60_000,
  )

  cliIt.concurrent(
    "debug config supports -o file export",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const jsonOut = path.join(home, "debug-config.json")
        const res = yield* opencode.spawn(["debug", "config", "-o", jsonOut])
        opencode.expectExit(res, 0)
        expect(res.stderr).toContain("Wrote resolved config to")
        const jsonContent = yield* Effect.promise(() => fs.readFile(jsonOut, "utf-8"))
        const parsed = JSON.parse(jsonContent)
        expect(typeof parsed).toBe("object")
      }),
    60_000,
  )
})
