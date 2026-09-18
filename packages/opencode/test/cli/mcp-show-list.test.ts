import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"
import { McpListCommand, McpShowCommand, McpAuthListCommand } from "../../src/cli/cmd/mcp"
import yargs, { type Argv } from "yargs"

describe("McpCommand builders and options", () => {
  test("McpListCommand registers json option and aliases ls", () => {
    expect(McpListCommand.aliases).toContain("ls")
    const builder = McpListCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.json).toBeDefined()
  })

  test("McpShowCommand registers name and json options and aliases get", () => {
    expect(McpShowCommand.aliases).toContain("get")
    const builder = McpShowCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.json).toBeDefined()
  })

  test("McpAuthListCommand registers json option and aliases ls", () => {
    expect(McpAuthListCommand.aliases).toContain("ls")
    const builder = McpAuthListCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.json).toBeDefined()
  })
})

describe("opencode mcp list and show (subprocess)", () => {
  cliIt.concurrent(
    "lists empty servers as empty JSON array",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["mcp", "list", "--json"])
        opencode.expectExit(result, 0)
        const list = JSON.parse(result.stdout)
        expect(Array.isArray(list)).toBe(true)
        expect(list.length).toBe(0)
      }),
    60_000,
  )

  cliIt.concurrent(
    "lists and shows configured remote and local MCP servers",
    ({ opencode }) =>
      Effect.gen(function* () {
        // 1. Add remote server
        const addRemoteResult = yield* opencode.spawn([
          "mcp",
          "add",
          "remote-hub",
          "--url",
          "https://example.com/mcp",
          "--header",
          "X-Custom-Header=value123",
        ])
        opencode.expectExit(addRemoteResult, 0)

        // 2. Add local server
        const addLocalResult = yield* opencode.spawn([
          "mcp",
          "add",
          "local-tool",
          "--env",
          "FOO=bar",
          "--",
          "echo",
          "hello",
        ])
        opencode.expectExit(addLocalResult, 0)

        // 3. Test mcp list --json
        const listResult = yield* opencode.spawn(["mcp", "list", "--json"])
        opencode.expectExit(listResult, 0)
        const list = JSON.parse(listResult.stdout)
        expect(Array.isArray(list)).toBe(true)
        expect(list.length).toBe(2)

        const remoteEntry = list.find((s: any) => s.name === "remote-hub")
        expect(remoteEntry).toBeDefined()
        expect(remoteEntry.type).toBe("remote")
        expect(remoteEntry.url).toBe("https://example.com/mcp")
        expect(remoteEntry.headers).toEqual({ "X-Custom-Header": "value123" })
        expect(remoteEntry.enabled).toBe(true)

        const localEntry = list.find((s: any) => s.name === "local-tool")
        expect(localEntry).toBeDefined()
        expect(localEntry.type).toBe("local")
        expect(localEntry.command).toEqual(["echo", "hello"])
        expect(localEntry.environment).toEqual({ FOO: "bar" })
        expect(localEntry.enabled).toBe(true)

        // 4. Test mcp show <name> --json
        const showRemoteJson = yield* opencode.spawn(["mcp", "show", "remote-hub", "--json"])
        opencode.expectExit(showRemoteJson, 0)
        const remoteData = JSON.parse(showRemoteJson.stdout)
        expect(remoteData.name).toBe("remote-hub")
        expect(remoteData.type).toBe("remote")
        expect(remoteData.url).toBe("https://example.com/mcp")
        expect(remoteData.headers).toEqual({ "X-Custom-Header": "value123" })
        expect(remoteData.enabled).toBe(true)

        // 5. Test mcp get alias
        const getLocalJson = yield* opencode.spawn(["mcp", "get", "local-tool", "--json"])
        opencode.expectExit(getLocalJson, 0)
        const localData = JSON.parse(getLocalJson.stdout)
        expect(localData.name).toBe("local-tool")
        expect(localData.type).toBe("local")
        expect(localData.command).toEqual(["echo", "hello"])

        // 6. Test mcp show <name> formatted text
        const showText = yield* opencode.spawn(["mcp", "show", "remote-hub"])
        opencode.expectExit(showText, 0)
        expect(showText.stdout).toContain("Server: remote-hub (remote)")
        expect(showText.stdout).toContain("URL: https://example.com/mcp")
        expect(showText.stdout).toContain("Enabled: yes")

        // 7. Test mcp show missing server
        const showMissing = yield* opencode.spawn(["mcp", "show", "nonexistent-mcp"])
        opencode.expectExit(showMissing, 1)
        expect(showMissing.stderr).toContain("MCP server not found: nonexistent-mcp")

        // 8. Test mcp auth list --json
        const authList = yield* opencode.spawn(["mcp", "auth", "list", "--json"])
        opencode.expectExit(authList, 0)
        const authServers = JSON.parse(authList.stdout)
        expect(Array.isArray(authServers)).toBe(true)
        expect(authServers.length).toBe(1)
        expect(authServers[0].name).toBe("remote-hub")
        expect(authServers[0].url).toBe("https://example.com/mcp")
        expect(authServers[0].authStatus).toBeDefined()
      }),
    60_000,
  )
})
