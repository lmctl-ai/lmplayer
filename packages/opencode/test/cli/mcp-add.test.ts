import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import fs from "node:fs/promises"
import { cliIt } from "../lib/cli-process"

describe("opencode mcp add (non-interactive subprocess)", () => {
  cliIt.concurrent(
    "adds a remote server with HTTP headers",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn([
          "mcp",
          "add",
          "github",
          "--url",
          "https://example.com/mcp",
          "--header",
          "Authorization=Bearer {env:GITHUB_TOKEN}",
          "--header",
          "X-Option=one=two",
        ])
        opencode.expectExit(result, 0)

        const config = yield* Effect.promise(() =>
          Bun.file(path.join(home, ".config", "lmplayer", "opencode.json")).json(),
        )
        expect(config.mcp.github).toEqual({
          type: "remote",
          url: "https://example.com/mcp",
          headers: {
            Authorization: "Bearer {env:GITHUB_TOKEN}",
            "X-Option": "one=two",
          },
        })
      }),
    60_000,
  )

  cliIt.concurrent(
    "adds a local server while preserving argv and environment values",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn([
          "mcp",
          "add",
          "local",
          "--env",
          "API_KEY=secret",
          "--env",
          "VALUE=one=two",
          "--",
          "npx",
          "-y",
          "@example/server",
          "--label",
          "two words",
        ])
        opencode.expectExit(result, 0)

        const config = yield* Effect.promise(() =>
          Bun.file(path.join(home, ".config", "lmplayer", "opencode.json")).json(),
        )
        expect(config.mcp.local).toEqual({
          type: "local",
          command: ["npx", "-y", "@example/server", "--label", "two words"],
          environment: {
            API_KEY: "secret",
            VALUE: "one=two",
          },
        })
      }),
    60_000,
  )

  cliIt.concurrent(
    "adds a server to project config using --project",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn([
          "mcp",
          "add",
          "proj-server",
          "--url",
          "https://example.com/project-mcp",
          "--project",
        ])
        opencode.expectExit(result, 0)

        const config = yield* Effect.promise(() => Bun.file(path.join(home, "opencode.json")).json())
        expect(config.mcp["proj-server"]).toEqual({
          type: "remote",
          url: "https://example.com/project-mcp",
        })
      }),
    60_000,
  )

  cliIt.concurrent(
    "adds a server to project config using --scope project",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn([
          "mcp",
          "add",
          "scoped-proj-server",
          "--url",
          "https://example.com/scoped-mcp",
          "--scope",
          "project",
        ])
        opencode.expectExit(result, 0)

        const config = yield* Effect.promise(() => Bun.file(path.join(home, "opencode.json")).json())
        expect(config.mcp["scoped-proj-server"]).toEqual({
          type: "remote",
          url: "https://example.com/scoped-mcp",
        })
      }),
    60_000,
  )

  cliIt.concurrent(
    "adds a server to .opencode/opencode.json if .opencode dir exists",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(home, ".opencode"), { recursive: true }))
        const result = yield* opencode.spawn([
          "mcp",
          "add",
          "subfolder-server",
          "--url",
          "https://example.com/subfolder",
          "-p",
        ])
        opencode.expectExit(result, 0)

        const config = yield* Effect.promise(() => Bun.file(path.join(home, ".opencode", "opencode.json")).json())
        expect(config.mcp["subfolder-server"]).toEqual({
          type: "remote",
          url: "https://example.com/subfolder",
        })
      }),
    60_000,
  )

  cliIt.concurrent(
    "adds a server to global config using --scope global",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn([
          "mcp",
          "add",
          "global-server",
          "--url",
          "https://example.com/global",
          "--scope",
          "global",
        ])
        opencode.expectExit(result, 0)

        const config = yield* Effect.promise(() =>
          Bun.file(path.join(home, ".config", "lmplayer", "opencode.json")).json(),
        )
        expect(config.mcp["global-server"]).toEqual({
          type: "remote",
          url: "https://example.com/global",
        })
      }),
    60_000,
  )

  cliIt.concurrent(
    "fails when both --global and --project are specified",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn([
          "mcp",
          "add",
          "conflict-server",
          "--url",
          "https://example.com/conflict",
          "--global",
          "--project",
        ])
        opencode.expectExit(result, 1)
        expect(result.stderr).toContain("Cannot specify both global and project scope")
      }),
    60_000,
  )

  cliIt.concurrent(
    "adds an MCP server with -o output file (text) and --output --json (json)",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const textOutFile = path.join(home, "mcp-add-out.txt")
        const resText = yield* opencode.spawn([
          "mcp",
          "add",
          "text-server",
          "--url",
          "https://example.com/text",
          "-o",
          textOutFile,
        ])
        opencode.expectExit(resText, 0)
        expect(resText.stderr).toContain("Wrote MCP add result to")
        const textContent = yield* Effect.promise(() => fs.readFile(textOutFile, "utf-8"))
        expect(textContent).toContain('MCP server "text-server" added to')

        const jsonOutFile = path.join(home, "mcp-add-out.json")
        const resJson = yield* opencode.spawn([
          "mcp",
          "add",
          "json-server",
          "--url",
          "https://example.com/json",
          "--output",
          jsonOutFile,
          "--json",
        ])
        opencode.expectExit(resJson, 0)
        expect(resJson.stderr).toContain("Wrote MCP add result to")
        const jsonContent = yield* Effect.promise(() => fs.readFile(jsonOutFile, "utf-8"))
        const parsedJson = JSON.parse(jsonContent)
        expect(parsedJson.ok).toBe(true)
        expect(parsedJson.name).toBe("json-server")
        expect(parsedJson.type).toBe("remote")
      }),
    60_000,
  )
})
