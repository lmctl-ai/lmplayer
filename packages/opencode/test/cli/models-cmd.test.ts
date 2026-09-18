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
})
