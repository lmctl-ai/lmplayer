import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import fs from "fs/promises"
import { cliIt } from "../lib/cli-process"

describe("opencode mcp enable / disable (non-interactive subprocess)", () => {
  cliIt.concurrent(
    "disables and enables an existing global MCP server",
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

        const disableResult = yield* opencode.spawn(["mcp", "disable", "github"])
        opencode.expectExit(disableResult, 0)

        const configAfterDisable = yield* Effect.promise(() =>
          Bun.file(path.join(home, ".config", "lmplayer", "opencode.json")).json(),
        )
        expect(configAfterDisable.mcp.github.enabled).toBe(false)

        const enableResult = yield* opencode.spawn(["mcp", "enable", "github"])
        opencode.expectExit(enableResult, 0)

        const configAfterEnable = yield* Effect.promise(() =>
          Bun.file(path.join(home, ".config", "lmplayer", "opencode.json")).json(),
        )
        expect(configAfterEnable.mcp.github.enabled).toBe(true)
      }),
    60_000,
  )

  cliIt.concurrent(
    "disables and enables a project MCP server with --project",
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

        const disableResult = yield* opencode.spawn(["mcp", "disable", "proj-server", "-p"])
        opencode.expectExit(disableResult, 0)

        const configAfterDisable = yield* Effect.promise(() =>
          Bun.file(path.join(home, "opencode.json")).json(),
        )
        expect(configAfterDisable.mcp["proj-server"].enabled).toBe(false)

        const enableResult = yield* opencode.spawn(["mcp", "enable", "proj-server", "--scope", "project"])
        opencode.expectExit(enableResult, 0)

        const configAfterEnable = yield* Effect.promise(() =>
          Bun.file(path.join(home, "opencode.json")).json(),
        )
        expect(configAfterEnable.mcp["proj-server"].enabled).toBe(true)
      }),
    60_000,
  )

  cliIt.concurrent(
    "fails when server is not found",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["mcp", "disable", "nonexistent"])
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
          "enable",
          "conflict-server",
          "--global",
          "--project",
        ])
        opencode.expectExit(result, 1)
        expect(result.stderr).toContain("Cannot specify both global and project scope")
      }),
    60_000,
  )

  cliIt.concurrent(
    "enables/disables an MCP server with -o output file (text) and --output --json (json)",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const addResult = yield* opencode.spawn([
          "mcp",
          "add",
          "toggle-server",
          "--url",
          "https://example.com/toggle",
        ])
        opencode.expectExit(addResult, 0)

        const textOut = path.join(home, "disable-out.txt")
        const disRes = yield* opencode.spawn(["mcp", "disable", "toggle-server", "-o", textOut])
        opencode.expectExit(disRes, 0)
        expect(disRes.stderr).toContain("Wrote disable result to")
        const textContent = yield* Effect.promise(() => fs.readFile(textOut, "utf-8"))
        expect(textContent).toContain('MCP server "toggle-server" disabled')

        const jsonOut = path.join(home, "enable-out.json")
        const enRes = yield* opencode.spawn(["mcp", "enable", "toggle-server", "--output", jsonOut, "--json"])
        opencode.expectExit(enRes, 0)
        expect(enRes.stderr).toContain("Wrote enable result to")
        const jsonContent = yield* Effect.promise(() => fs.readFile(jsonOut, "utf-8"))
        const parsedJson = JSON.parse(jsonContent)
        expect(parsedJson.ok).toBe(true)
        expect(parsedJson.name).toBe("toggle-server")
        expect(parsedJson.enabled).toBe(true)
      }),
    60_000,
  )
})
