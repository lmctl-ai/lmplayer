import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import fs from "node:fs/promises"
import { cliIt } from "../lib/cli-process"

describe("opencode providers / auth CLI subprocess", () => {
  cliIt.concurrent(
    "providers list --json outputs credentials path and providers list",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["providers", "list", "--json"])
        opencode.expectExit(result, 0)
        const parsed = JSON.parse(result.stdout)
        expect(parsed.credentials_path).toBeDefined()
        expect(Array.isArray(parsed.providers)).toBe(true)
      }),
    60_000,
  )

  cliIt.concurrent(
    "providers list supports --output file export",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const outFile = path.join(home, "providers.json")
        const result = yield* opencode.spawn(["providers", "list", "--json", "-o", outFile])
        opencode.expectExit(result, 0)
        const content = JSON.parse(yield* Effect.promise(() => fs.readFile(outFile, "utf-8")))
        expect(content.credentials_path).toBeDefined()
        expect(Array.isArray(content.providers)).toBe(true)
      }),
    60_000,
  )

  cliIt.concurrent(
    "providers list supports search query and --all catalog listing",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["providers", "list", "-q", "anthropic", "--all", "--json"])
        opencode.expectExit(result, 0)
        const parsed = JSON.parse(result.stdout)
        expect(Array.isArray(parsed.providers)).toBe(true)
        expect(parsed.providers.length).toBeGreaterThan(0)
        expect(parsed.providers.some((p: any) => p.id === "anthropic")).toBe(true)
      }),
    60_000,
  )

  cliIt.concurrent(
    "providers show supports --json and --output",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const outFile = path.join(home, "anthropic.json")
        const result = yield* opencode.spawn(["providers", "show", "anthropic", "--json", "-o", outFile])
        opencode.expectExit(result, 0)
        const content = JSON.parse(yield* Effect.promise(() => fs.readFile(outFile, "utf-8")))
        expect(content.id).toBe("anthropic")
        expect(content.name).toBe("Anthropic")
        expect(content.status).toBe("enabled")
      }),
    60_000,
  )

  cliIt.concurrent(
    "providers logout handles non-interactive mode and unknown provider cleanly",
    ({ opencode }) =>
      Effect.gen(function* () {
        // Without provider in non-interactive mode: fails
        const noProvResult = yield* opencode.spawn(["providers", "logout", "--json"])
        opencode.expectExit(noProvResult, 1)
        const noProvParsed = JSON.parse(noProvResult.stdout)
        expect(noProvParsed.ok).toBe(false)
        expect(noProvParsed.error).toContain("non-interactive")

        // Unknown provider without --force: fails
        const failResult = yield* opencode.spawn(["providers", "logout", "nonexistent-xyz", "--json"])
        opencode.expectExit(failResult, 1)
        const failParsed = JSON.parse(failResult.stdout)
        expect(failParsed.ok).toBe(false)

        // Unknown provider with --force: succeeds
        const forceResult = yield* opencode.spawn(["providers", "logout", "nonexistent-xyz", "--force", "--json"])
        opencode.expectExit(forceResult, 0)
        const forceParsed = JSON.parse(forceResult.stdout)
        expect(forceParsed.ok).toBe(true)
        expect(forceParsed.removed).toBe(false)
      }),
    60_000,
  )
})
