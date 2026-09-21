import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import fs from "fs/promises"
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

  cliIt.concurrent(
    "removes an MCP server with -o output file (text) and --output --json (json), and handles --force",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const add1 = yield* opencode.spawn(["mcp", "add", "srv1", "--url", "https://example.com/1"])
        opencode.expectExit(add1, 0)
        const add2 = yield* opencode.spawn(["mcp", "add", "srv2", "--url", "https://example.com/2"])
        opencode.expectExit(add2, 0)

        // 1. Text output
        const textOut = path.join(home, "remove-out.txt")
        const rmTextRes = yield* opencode.spawn(["mcp", "remove", "srv1", "-o", textOut])
        opencode.expectExit(rmTextRes, 0)
        expect(rmTextRes.stderr).toContain("Wrote removal result to")
        const textContent = yield* Effect.promise(() => fs.readFile(textOut, "utf-8"))
        expect(textContent).toContain('MCP server "srv1" removed from')

        // 2. JSON output
        const jsonOut = path.join(home, "remove-out.json")
        const rmJsonRes = yield* opencode.spawn(["mcp", "remove", "srv2", "--output", jsonOut, "--json"])
        opencode.expectExit(rmJsonRes, 0)
        expect(rmJsonRes.stderr).toContain("Wrote removal result to")
        const jsonContent = yield* Effect.promise(() => fs.readFile(jsonOut, "utf-8"))
        const parsedJson = JSON.parse(jsonContent)
        expect(parsedJson.ok).toBe(true)
        expect(parsedJson.name).toBe("srv2")
        expect(parsedJson.removed).toBe(true)

        // 3. Force removal for nonexistent server
        const forceOut = path.join(home, "force-out.json")
        const rmForceRes = yield* opencode.spawn([
          "mcp",
          "remove",
          "nonexistent",
          "--force",
          "--output",
          forceOut,
          "--json",
        ])
        opencode.expectExit(rmForceRes, 0)
        const forceContent = yield* Effect.promise(() => fs.readFile(forceOut, "utf-8"))
        const parsedForce = JSON.parse(forceContent)
        expect(parsedForce.ok).toBe(false)
        expect(parsedForce.name).toBe("nonexistent")
      }),
    60_000,
  )
})
