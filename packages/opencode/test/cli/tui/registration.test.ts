import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"

describe("cli registration", () => {
  cliIt.live("registers tui and attach as non-default subcommands", ({ opencode }) =>
    Effect.gen(function* () {
      const result = yield* opencode.spawn(["--help"])

      opencode.expectExit(result, 0)
      // yargs writes --help output to stderr, not stdout.
      expect(result.stderr).toContain("tui")
      expect(result.stderr).toContain("attach")
      expect(result.stderr).toContain("[message..]")
    }),
  )

  cliIt.live("tui --help reaches the tui command", ({ opencode }) =>
    Effect.gen(function* () {
      const result = yield* opencode.spawn(["tui", "--help"])

      opencode.expectExit(result, 0)
      expect(result.stderr).toContain("start lmplayer tui")
    }),
  )

  cliIt.live("attach --help reaches the attach command", ({ opencode }) =>
    Effect.gen(function* () {
      const result = yield* opencode.spawn(["attach", "--help"])

      opencode.expectExit(result, 0)
      expect(result.stderr).toContain("attach to a running lmplayer server")
    }),
  )
})
