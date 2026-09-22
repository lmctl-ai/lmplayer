import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { cliIt } from "../lib/cli-process"
import { McpListCommand, McpShowCommand, McpAuthCommand, McpAuthListCommand, McpLogoutCommand } from "../../src/cli/cmd/mcp"
import yargs, { type Argv } from "yargs"

describe("McpCommand builders and options", () => {
  test("McpListCommand registers json, output, search, type, and enabled options and aliases ls", () => {
    expect(McpListCommand.aliases).toContain("ls")
    const builder = McpListCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.json).toBeDefined()
    expect(options.key.output).toBeDefined()
    expect(options.key.search).toBeDefined()
    expect(options.key.type).toBeDefined()
    expect(options.key.enabled).toBeDefined()
  })

  test("McpShowCommand registers name, json, and output options and aliases get", () => {
    expect(McpShowCommand.aliases).toContain("get")
    const builder = McpShowCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.json).toBeDefined()
    expect(options.key.output).toBeDefined()
  })

  test("McpAuthListCommand registers json, output, search, and status options and aliases ls", () => {
    expect(McpAuthListCommand.aliases).toContain("ls")
    const builder = McpAuthListCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.json).toBeDefined()
    expect(options.key.output).toBeDefined()
    expect(options.key.search).toBeDefined()
    expect(options.key.status).toBeDefined()
  })

  test("McpLogoutCommand registers force, json, and output options", () => {
    const builder = McpLogoutCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.force).toBeDefined()
    expect(options.key.json).toBeDefined()
    expect(options.key.output).toBeDefined()
  })

  test("McpAuthCommand registers name, json, and output options", () => {
    const builder = McpAuthCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.json).toBeDefined()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
  })

  test("McpAuthCommand parses options from arguments", async () => {
    const builder = McpAuthCommand.builder as (y: Argv) => Argv<any>
    const parsed = await builder(yargs()).parseAsync([
      "--output",
      "auth-summary.json",
      "--json",
    ])
    expect(parsed.output).toBe("auth-summary.json")
    expect(parsed.json).toBe(true)
  })

  test("McpAuthCommand parses -o short alias", async () => {
    const builder = McpAuthCommand.builder as (y: Argv) => Argv<any>
    const parsed = await builder(yargs()).parseAsync(["-o", "auth.txt"])
    expect(parsed.output).toBe("auth.txt")
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
    ({ home, opencode }) =>
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

        // 9. Test mcp list -o <file> (human formatted text)
        const listTextFile = path.join(home, "mcp-list.txt")
        const listExportText = yield* opencode.spawn(["mcp", "list", "-o", listTextFile])
        opencode.expectExit(listExportText, 0)
        expect(listExportText.stderr).toContain("Wrote MCP servers list to")
        const listFileContent = yield* Effect.promise(() => Bun.file(listTextFile).text())
        expect(listFileContent).toContain("MCP Servers")
        expect(listFileContent).toContain("remote-hub (remote)")
        expect(listFileContent).toContain("local-tool (local)")

        // 10. Test mcp list --json -o <file> (JSON file export)
        const listJsonFile = path.join(home, "mcp-list.json")
        const listExportJson = yield* opencode.spawn(["mcp", "list", "--json", "-o", listJsonFile])
        opencode.expectExit(listExportJson, 0)
        expect(listExportJson.stderr).toContain("Wrote MCP servers list to")
        const listJsonContent = yield* Effect.promise(() => Bun.file(listJsonFile).json())
        expect(Array.isArray(listJsonContent)).toBe(true)
        expect(listJsonContent.length).toBe(2)

        // 11. Test mcp list search filtering (-q / --search)
        const listSearch = yield* opencode.spawn(["mcp", "list", "-q", "remote", "--json"])
        opencode.expectExit(listSearch, 0)
        const searchList = JSON.parse(listSearch.stdout)
        expect(searchList.length).toBe(1)
        expect(searchList[0].name).toBe("remote-hub")

        // 12. Test mcp list type filtering (-t / --type)
        const listType = yield* opencode.spawn(["mcp", "list", "-t", "local", "--json"])
        opencode.expectExit(listType, 0)
        const typeList = JSON.parse(listType.stdout)
        expect(typeList.length).toBe(1)
        expect(typeList[0].name).toBe("local-tool")

        // 13. Test mcp show <name> -o <file>
        const showTextFile = path.join(home, "mcp-show.txt")
        const showExport = yield* opencode.spawn(["mcp", "show", "remote-hub", "-o", showTextFile])
        opencode.expectExit(showExport, 0)
        expect(showExport.stderr).toContain("Wrote MCP server details to")
        const showFileContent = yield* Effect.promise(() => Bun.file(showTextFile).text())
        expect(showFileContent).toContain("Server: remote-hub (remote)")
        expect(showFileContent).toContain("URL: https://example.com/mcp")

        // 14. Test mcp auth list -o <file>
        const authTextFile = path.join(home, "mcp-auth.txt")
        const authExport = yield* opencode.spawn(["mcp", "auth", "list", "-o", authTextFile])
        opencode.expectExit(authExport, 0)
        expect(authExport.stderr).toContain("Wrote OAuth status list to")
        const authFileContent = yield* Effect.promise(() => Bun.file(authTextFile).text())
        expect(authFileContent).toContain("MCP OAuth Status")
        expect(authFileContent).toContain("remote-hub")

        // 15. Test mcp logout --force --json on unauthenticated/missing server
        const logoutForce = yield* opencode.spawn(["mcp", "logout", "nonexistent-mcp", "--force", "--json"])
        opencode.expectExit(logoutForce, 0)
        const logoutResult = JSON.parse(logoutForce.stdout)
        expect(logoutResult.ok).toBe(true)
        expect(logoutResult.name).toBe("nonexistent-mcp")
        expect(logoutResult.removed).toBe(false)

        // 16. Test mcp logout without server in non-interactive mode
        const logoutNoArgs = yield* opencode.spawn(["mcp", "logout", "--json"])
        opencode.expectExit(logoutNoArgs, 1)
        const logoutNoArgsResult = JSON.parse(logoutNoArgs.stdout)
        expect(logoutNoArgsResult.ok).toBe(false)
        expect(logoutNoArgsResult.error).toContain("Server name is required")
      }),
    60_000,
  )
})
