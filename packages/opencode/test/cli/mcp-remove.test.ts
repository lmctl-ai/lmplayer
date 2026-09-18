import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { cliIt } from "../lib/cli-process"

describe("opencode mcp remove (non-interactive subprocess)", () => {
  cliIt.concurrent(
    "removes an existing global MCP server",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const addResult = yield* opencode.spawn([
          "mcp",
          "add",
          "github",
          "--url",
          "https://example.com/mcp",
        ])
        opencode.expectExit(addResult, 0)

        const configBeforeRemove = yield* Effect.promise(() =>
          Bun.file(path.join(home, ".config", "lmplayer", "opencode.json")).json(),
        )
        expect(configBeforeRemove.mcp.github).toBeDefined()

        const removeResult = yield* opencode.spawn(["mcp", "remove", "github"])
        opencode.expectExit(removeResult, 0)

        const configAfterRemove = yield* Effect.promise(() =>
          Bun.file(path.join(home, ".config", "lmplayer", "opencode.json")).json(),
        )
        expect(configAfterRemove.mcp?.github).toBeUndefined()
      }),
    60_000,
  )

  cliIt.concurrent(
    "removes a project MCP server using rm alias and --project",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const addResult = yield* opencode.spawn([
          "mcp",
          "add",
          "proj-server",
          "--url",
          "https://example.com/mcp",
          "--project",
        ])
        opencode.expectExit(addResult, 0)

        const configBeforeRemove = yield* Effect.promise(() =>
          Bun.file(path.join(home, "opencode.json")).json(),
        )
        expect(configBeforeRemove.mcp["proj-server"]).toBeDefined()

        const removeResult = yield* opencode.spawn(["mcp", "rm", "proj-server", "-p"])
        opencode.expectExit(removeResult, 0)

        const configAfterRemove = yield* Effect.promise(() =>
          Bun.file(path.join(home, "opencode.json")).json(),
        )
        expect(configAfterRemove.mcp?.["proj-server"]).toBeUndefined()
      }),
    60_000,
  )

  cliIt.concurrent(
    "fails when server is not found",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["mcp", "remove", "nonexistent"])
        opencode.expectExit(result, 1)
        expect(result.stderr).toContain('MCP server "nonexistent" not found in configuration')
      }),
    60_000,
  )

  cliIt.concurrent(
    "fails when both --global and --project are specified",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn([
          "mcp",
          "remove",
          "conflict-server",
          "--global",
          "--project",
        ])
        opencode.expectExit(result, 1)
        expect(result.stderr).toContain("Cannot specify both global and project scope")
      }),
    60_000,
  )
})
