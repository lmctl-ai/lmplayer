import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"

describe("opencode models test / verify (cli subprocess)", () => {
  cliIt.concurrent(
    "models verify rejects invalid format or unknown provider",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["models", "verify", "unknown-provider/unknown-model"])
        opencode.expectExit(result, 1)
        expect(result.stderr).toContain('unknown provider "unknown-provider"')
      }),
    60_000,
  )

  cliIt.concurrent(
    "models test rejects nonexistent provider",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["models", "test", "nonexistent-provider"])
        opencode.expectExit(result, 1)
        expect(result.stderr).toContain("Provider not found: nonexistent-provider")
      }),
    60_000,
  )

  cliIt.concurrent(
    "models list --json outputs JSON array of models",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["models", "list", "--json"])
        opencode.expectExit(result, 0)
        const parsed = JSON.parse(result.stdout)
        expect(Array.isArray(parsed)).toBe(true)
        expect(parsed.length).toBeGreaterThan(0)
        expect(parsed[0].id).toBeDefined()
        expect(parsed[0].provider).toBeDefined()
      }),
    60_000,
  )

  cliIt.concurrent(
    "models ls alias supports search filtering",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["models", "ls", "-q", "qwen", "--json"])
        opencode.expectExit(result, 0)
        const parsed = JSON.parse(result.stdout)
        expect(Array.isArray(parsed)).toBe(true)
        for (const entry of parsed) {
          const matches =
            entry.id.toLowerCase().includes("qwen") ||
            entry.name.toLowerCase().includes("qwen") ||
            entry.provider.toLowerCase().includes("qwen")
          expect(matches).toBe(true)
        }
      }),
    60_000,
  )

  cliIt.concurrent(
    "models list rejects nonexistent provider",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["models", "list", "nonexistent-provider-xyz"])
        opencode.expectExit(result, 1)
        expect(result.stderr).toContain("Provider not found: nonexistent-provider-xyz")
      }),
    60_000,
  )
})

