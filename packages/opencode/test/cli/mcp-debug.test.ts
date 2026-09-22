import { describe, expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import fs from "node:fs/promises"
import yargs, { type Argv } from "yargs"
import {
  McpDebugCommand,
  buildMcpDebugResult,
  formatMcpDebugText,
  writeMcpDebugOutputFile,
} from "../../src/cli/cmd/mcp"

describe("McpDebugCommand builder and options", () => {
  test("registers name positional argument, json, and output options", () => {
    const builder = McpDebugCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.json).toBeDefined()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
  })
})

describe("buildMcpDebugResult and formatMcpDebugText", () => {
  test("builds result and formats text for missing server", () => {
    const result = buildMcpDebugResult({
      server: "nonexistent",
      found: false,
      error: "MCP server not found: nonexistent",
    })
    expect(result.server).toBe("nonexistent")
    expect(result.found).toBe(false)
    expect(result.error).toBe("MCP server not found: nonexistent")

    const text = formatMcpDebugText(result)
    expect(text[0]).toBe("MCP Server Debug: nonexistent")
    expect(text[1]).toContain("Error: MCP server not found: nonexistent")
  })

  test("builds result and formats text for local non-remote server", () => {
    const result = buildMcpDebugResult({
      server: "local-tool",
      found: true,
      isRemote: false,
      error: "MCP server local-tool is not a remote server",
    })
    expect(result.isRemote).toBe(false)

    const text = formatMcpDebugText(result)
    expect(text).toContain("  Error: MCP server local-tool is not a remote server")
  })

  test("builds result and formats text for OAuth disabled server", () => {
    const result = buildMcpDebugResult({
      server: "no-oauth-server",
      found: true,
      isRemote: true,
      oauthExplicitlyDisabled: true,
      url: "https://example.com/mcp",
    })
    expect(result.oauthExplicitlyDisabled).toBe(true)

    const text = formatMcpDebugText(result)
    expect(text).toContain("  URL: https://example.com/mcp")
    expect(text).toContain("  Warning: MCP server no-oauth-server has OAuth explicitly disabled")
  })

  test("builds comprehensive result and formats text with tokens, clientInfo, and HTTP probe", () => {
    const result = buildMcpDebugResult({
      server: "remote-hub",
      found: true,
      isRemote: true,
      url: "https://hub.example.com/mcp",
      authStatus: "authenticated",
      authStatusText: "authenticated",
      tokens: {
        accessTokenMasked: "eyJh***1234",
        expiresAt: "2026-10-01T00:00:00.000Z",
        isExpired: false,
        hasRefreshToken: true,
      },
      clientInfo: {
        clientId: "client-id-xyz",
        clientSecretExpiresAt: "2027-01-01T00:00:00.000Z",
      },
      http: {
        status: 200,
        statusText: "OK",
        serverInfo: { name: "hub-server", version: "1.0.0" },
      },
      connectionSuccessful: true,
    })

    expect(result.connectionSuccessful).toBe(true)
    expect(result.tokens?.accessTokenMasked).toBe("eyJh***1234")
    expect(result.clientInfo?.clientId).toBe("client-id-xyz")
    expect(result.http?.status).toBe(200)

    const text = formatMcpDebugText(result)
    expect(text).toContain("  URL: https://hub.example.com/mcp")
    expect(text).toContain("  Auth status: authenticated")
    expect(text).toContain("  Access token: eyJh***1234")
    expect(text).toContain("  Expires: 2026-10-01T00:00:00.000Z")
    expect(text).toContain("  Refresh token: present")
    expect(text).toContain("  Client ID: client-id-xyz")
    expect(text).toContain("  HTTP response: 200 OK")
    expect(text).toContain("  Server info: {\"name\":\"hub-server\",\"version\":\"1.0.0\"}")
    expect(text).toContain("  Connection: successful")
  })

  test("builds result and formats text for HTTP 401 OAuth challenge and dynamic registration", () => {
    const result = buildMcpDebugResult({
      server: "auth-required-hub",
      found: true,
      isRemote: true,
      url: "https://auth.example.com/mcp",
      authStatus: "not_authenticated",
      authStatusText: "not authenticated",
      clientInfo: {
        hasDynamicRegistration: true,
      },
      http: {
        status: 401,
        statusText: "Unauthorized",
        wwwAuthenticate: 'Bearer realm="OAuth"',
        requiresOAuth: true,
      },
      oauthFlowTriggered: true,
    })

    expect(result.http?.requiresOAuth).toBe(true)
    expect(result.oauthFlowTriggered).toBe(true)

    const text = formatMcpDebugText(result)
    expect(text).toContain("  HTTP response: 401 Unauthorized")
    expect(text).toContain('  WWW-Authenticate: Bearer realm="OAuth"')
    expect(text).toContain("  OAuth required: yes (401 response)")
    expect(text).toContain("  Dynamic registration: will be attempted")
    expect(text).toContain("  OAuth flow: triggered")
  })

  test("builds result and formats text for connection error", () => {
    const result = buildMcpDebugResult({
      server: "broken-server",
      found: true,
      isRemote: true,
      url: "https://broken.example.com",
      http: {
        error: "fetch failed: ECONNREFUSED",
      },
      error: "fetch failed: ECONNREFUSED",
    })

    const text = formatMcpDebugText(result)
    expect(text).toContain("  Connection error: fetch failed: ECONNREFUSED")
  })
})

describe("writeMcpDebugOutputFile", () => {
  test("writes formatted text report and creates subdirectories", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-debug-test-"))
    try {
      const targetFile = path.join(tempDir, "reports", "mcp-debug.txt")
      const result = buildMcpDebugResult({
        server: "my-tool",
        found: true,
        isRemote: false,
        error: "MCP server my-tool is not a remote server",
      })
      await writeMcpDebugOutputFile(targetFile, result, false)

      const fileContent = await fs.readFile(targetFile, "utf-8")
      expect(fileContent).toContain("MCP Server Debug: my-tool")
      expect(fileContent).toContain("Error: MCP server my-tool is not a remote server")
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  test("writes JSON report when isJson is true or filename ends with .json", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-debug-json-"))
    try {
      const targetFile = path.join(tempDir, "out", "debug.json")
      const result = buildMcpDebugResult({
        server: "remote-api",
        found: true,
        isRemote: true,
        url: "https://api.example.com/mcp",
        connectionSuccessful: true,
      })
      await writeMcpDebugOutputFile(targetFile, result, true)

      const fileContent = await fs.readFile(targetFile, "utf-8")
      const parsed = JSON.parse(fileContent)
      expect(parsed.server).toBe("remote-api")
      expect(parsed.found).toBe(true)
      expect(parsed.connectionSuccessful).toBe(true)
      expect(parsed.url).toBe("https://api.example.com/mcp")
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })
})
