import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { effectCmd, fail } from "../effect-cmd"
import { Cause } from "effect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { MCP } from "../../mcp"
import { McpAuth } from "../../mcp/auth"
import { McpOAuthProvider } from "../../mcp/oauth-provider"
import { Config } from "@/config/config"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { InstanceRef } from "@/effect/instance-ref"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { modify, applyEdits, parse } from "jsonc-parser"
import { Filesystem } from "@/util/filesystem"
import { Effect } from "effect"
import { EOL } from "os"

function getAuthStatusIcon(status: MCP.AuthStatus): string {
  switch (status) {
    case "authenticated":
      return "✓"
    case "expired":
      return "⚠"
    case "not_authenticated":
      return "✗"
  }
}

function getAuthStatusText(status: MCP.AuthStatus): string {
  switch (status) {
    case "authenticated":
      return "authenticated"
    case "expired":
      return "expired"
    case "not_authenticated":
      return "not authenticated"
  }
}

type McpEntry = NonNullable<ConfigV1.Info["mcp"]>[string]

type McpConfigured = ConfigMCPV1.Info
function isMcpConfigured(config: McpEntry): config is McpConfigured {
  return typeof config === "object" && config !== null && "type" in config
}

type McpRemote = Extract<McpConfigured, { type: "remote" }>
function isMcpRemote(config: McpEntry): config is McpRemote {
  return isMcpConfigured(config) && config.type === "remote"
}

function configuredServers(config: ConfigV1.Info) {
  return Object.entries(config.mcp ?? {}).filter((entry): entry is [string, McpConfigured] => isMcpConfigured(entry[1]))
}

function oauthServers(config: ConfigV1.Info) {
  return configuredServers(config).filter(
    (entry): entry is [string, McpRemote] => isMcpRemote(entry[1]) && entry[1].oauth !== false,
  )
}

function listState() {
  return Effect.gen(function* () {
    const cfg = yield* Config.Service
    const mcp = yield* MCP.Service
    const config = yield* cfg.get()
    const statuses = yield* mcp.status()
    const stored = yield* Effect.all(
      Object.fromEntries(configuredServers(config).map(([name]) => [name, mcp.hasStoredTokens(name)])),
      { concurrency: "unbounded" },
    )
    return { config, statuses, stored }
  })
}

function authState() {
  return Effect.gen(function* () {
    const cfg = yield* Config.Service
    const mcp = yield* MCP.Service
    const config = yield* cfg.get()
    const auth = yield* Effect.all(
      Object.fromEntries(oauthServers(config).map(([name]) => [name, mcp.getAuthStatus(name)])),
      { concurrency: "unbounded" },
    )
    return { config, auth }
  })
}

export type McpListArgs = {
  json?: boolean
  output?: string
  search?: string
  type?: "local" | "remote"
  enabled?: boolean
}

export const listMcp = Effect.fn("Cli.mcp.list")(function* (args: McpListArgs = {}) {
  const { config, statuses, stored } = yield* listState()
  let servers = configuredServers(config)

  if (args.search) {
    const q = args.search.toLowerCase()
    servers = servers.filter(([name, serverConfig]) => {
      if (name.toLowerCase().includes(q)) return true
      if (serverConfig.type.toLowerCase().includes(q)) return true
      if (serverConfig.type === "remote" && serverConfig.url.toLowerCase().includes(q)) return true
      if (serverConfig.type === "local" && serverConfig.command.some((c) => c.toLowerCase().includes(q))) return true
      return false
    })
  }

  if (args.type) {
    servers = servers.filter(([, serverConfig]) => serverConfig.type === args.type)
  }

  if (args.enabled !== undefined) {
    servers = servers.filter(([, serverConfig]) => (serverConfig.enabled ?? true) === args.enabled)
  }

  if (args.json) {
    const jsonStr =
      JSON.stringify(
        servers.map(([name, serverConfig]) => {
          const status = statuses[name]
          const hasOAuth = isMcpRemote(serverConfig) && !!serverConfig.oauth
          const hasStoredTokens = stored[name]
          return {
            name,
            type: serverConfig.type,
            enabled: serverConfig.enabled ?? true,
            status: status?.status ?? "not_initialized",
            error: status && "error" in status ? status.error : undefined,
            oauth: hasOAuth,
            hasStoredTokens: Boolean(hasStoredTokens),
            ...(serverConfig.type === "remote"
              ? {
                  url: serverConfig.url,
                  headers: serverConfig.headers,
                }
              : {
                  command: serverConfig.command,
                  cwd: serverConfig.cwd,
                  environment: serverConfig.environment,
                }),
            timeout: serverConfig.timeout,
          }
        }),
        null,
        2,
      ) + EOL
    if (args.output) {
      const resolved = path.resolve(args.output)
      yield* Effect.promise(async () => {
        const fs = await import("fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        await fs.writeFile(resolved, jsonStr, "utf-8")
      })
      UI.println(`Wrote MCP servers list to ${resolved}`)
      return
    }
    process.stdout.write(jsonStr)
    return
  }

  if (args.output) {
    const lines: string[] = []
    lines.push("MCP Servers")
    if (servers.length === 0) {
      lines.push("No MCP servers configured")
    } else {
      for (const [name, serverConfig] of servers) {
        const status = statuses[name]
        const statusText = status?.status ?? "not initialized"
        const typeHint = serverConfig.type === "remote" ? serverConfig.url : serverConfig.command.join(" ")
        lines.push(`- ${name} (${serverConfig.type}): ${statusText}`)
        lines.push(`    ${typeHint}`)
      }
      lines.push(`${servers.length} server(s)`)
    }
    const resolved = path.resolve(args.output)
    yield* Effect.promise(async () => {
      const fs = await import("fs/promises")
      await fs.mkdir(path.dirname(resolved), { recursive: true })
      await fs.writeFile(resolved, lines.join(EOL) + EOL, "utf-8")
    })
    UI.println(`Wrote MCP servers list to ${resolved}`)
    return
  }

  UI.empty()
  prompts.intro("MCP Servers")

  if (servers.length === 0) {
    prompts.log.warn("No MCP servers configured")
    prompts.outro("Add servers with: lmplayer mcp add")
    return
  }

  for (const [name, serverConfig] of servers) {
    const status = statuses[name]
    const hasOAuth = isMcpRemote(serverConfig) && !!serverConfig.oauth
    const hasStoredTokens = stored[name]

    let statusIcon: string
    let statusText: string
    let hint = ""

    if (!status) {
      statusIcon = "○"
      statusText = "not initialized"
    } else if (status.status === "connected") {
      statusIcon = "✓"
      statusText = "connected"
      if (hasOAuth && hasStoredTokens) {
        hint = " (OAuth)"
      }
    } else if (status.status === "disabled") {
      statusIcon = "○"
      statusText = "disabled"
    } else if (status.status === "needs_auth") {
      statusIcon = "⚠"
      statusText = "needs authentication"
    } else if (status.status === "needs_client_registration") {
      statusIcon = "✗"
      statusText = "needs client registration"
      hint = "\n    " + status.error
    } else {
      statusIcon = "✗"
      statusText = "failed"
      hint = "\n    " + status.error
    }

    const typeHint = serverConfig.type === "remote" ? serverConfig.url : serverConfig.command.join(" ")
    prompts.log.info(
      `${statusIcon} ${name} ${UI.Style.TEXT_DIM}${statusText}${hint}\n    ${UI.Style.TEXT_DIM}${typeHint}`,
    )
  }

  prompts.outro(`${servers.length} server(s)`)
})

export type McpShowArgs = {
  name: string
  json?: boolean
  output?: string
}

export const showMcp = Effect.fn("Cli.mcp.show")(function* (args: McpShowArgs) {
  const { config, statuses, stored } = yield* listState()
  const serverConfig = config.mcp?.[args.name]
  if (!serverConfig || !isMcpConfigured(serverConfig)) {
    return yield* fail(`MCP server not found: ${args.name}`)
  }

  const status = statuses[args.name]
  const hasOAuth = isMcpRemote(serverConfig) && !!serverConfig.oauth
  const hasStoredTokens = stored[args.name]

  if (args.json) {
    const jsonStr =
      JSON.stringify(
        {
          name: args.name,
          type: serverConfig.type,
          enabled: serverConfig.enabled ?? true,
          status: status?.status ?? "not_initialized",
          error: status && "error" in status ? status.error : undefined,
          oauth: hasOAuth,
          hasStoredTokens: Boolean(hasStoredTokens),
          ...(serverConfig.type === "remote"
            ? {
                url: serverConfig.url,
                headers: serverConfig.headers,
              }
            : {
                command: serverConfig.command,
                cwd: serverConfig.cwd,
                environment: serverConfig.environment,
              }),
          timeout: serverConfig.timeout,
        },
        null,
        2,
      ) + EOL
    if (args.output) {
      const resolved = path.resolve(args.output)
      yield* Effect.promise(async () => {
        const fs = await import("fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        await fs.writeFile(resolved, jsonStr, "utf-8")
      })
      UI.println(`Wrote MCP server details to ${resolved}`)
      return
    }
    process.stdout.write(jsonStr)
    return
  }

  if (args.output) {
    const lines: string[] = []
    lines.push(`Server: ${args.name} (${serverConfig.type})`)
    lines.push(`  Status: ${status?.status ?? "not initialized"}`)
    if (status && "error" in status && status.error) {
      lines.push(`  Error: ${status.error}`)
    }
    lines.push(`  Enabled: ${serverConfig.enabled ?? true ? "yes" : "no"}`)
    if (serverConfig.type === "remote") {
      lines.push(`  URL: ${serverConfig.url}`)
      if (hasOAuth) {
        lines.push(`  OAuth: supported (stored tokens: ${hasStoredTokens ? "yes" : "no"})`)
      }
      if (serverConfig.headers && Object.keys(serverConfig.headers).length > 0) {
        lines.push(`  Headers: ${JSON.stringify(serverConfig.headers, null, 2)}`)
      }
    } else {
      lines.push(`  Command: ${serverConfig.command.join(" ")}`)
      if (serverConfig.cwd) {
        lines.push(`  CWD: ${serverConfig.cwd}`)
      }
      if (serverConfig.environment && Object.keys(serverConfig.environment).length > 0) {
        lines.push(`  Environment: ${JSON.stringify(serverConfig.environment, null, 2)}`)
      }
    }
    if (serverConfig.timeout) {
      lines.push(`  Timeout: ${serverConfig.timeout}ms`)
    }
    const resolved = path.resolve(args.output)
    yield* Effect.promise(async () => {
      const fs = await import("fs/promises")
      await fs.mkdir(path.dirname(resolved), { recursive: true })
      await fs.writeFile(resolved, lines.join(EOL) + EOL, "utf-8")
    })
    UI.println(`Wrote MCP server details to ${resolved}`)
    return
  }

  process.stdout.write(`Server: ${args.name} (${serverConfig.type})` + EOL)
  process.stdout.write(`  Status: ${status?.status ?? "not initialized"}` + EOL)
  if (status && "error" in status && status.error) {
    process.stdout.write(`  Error: ${status.error}` + EOL)
  }
  process.stdout.write(`  Enabled: ${serverConfig.enabled ?? true ? "yes" : "no"}` + EOL)
  if (serverConfig.type === "remote") {
    process.stdout.write(`  URL: ${serverConfig.url}` + EOL)
    if (hasOAuth) {
      process.stdout.write(`  OAuth: supported (stored tokens: ${hasStoredTokens ? "yes" : "no"})` + EOL)
    }
    if (serverConfig.headers && Object.keys(serverConfig.headers).length > 0) {
      process.stdout.write(`  Headers: ${JSON.stringify(serverConfig.headers, null, 2)}` + EOL)
    }
  } else {
    process.stdout.write(`  Command: ${serverConfig.command.join(" ")}` + EOL)
    if (serverConfig.cwd) {
      process.stdout.write(`  CWD: ${serverConfig.cwd}` + EOL)
    }
    if (serverConfig.environment && Object.keys(serverConfig.environment).length > 0) {
      process.stdout.write(`  Environment: ${JSON.stringify(serverConfig.environment, null, 2)}` + EOL)
    }
  }
  if (serverConfig.timeout) {
    process.stdout.write(`  Timeout: ${serverConfig.timeout}ms` + EOL)
  }
})

export const McpListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list MCP servers and their status",
  builder: (yargs: Argv) =>
    yargs
      .option("json", {
        type: "boolean",
        describe: "output JSON",
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write MCP servers list to output file path",
      })
      .option("search", {
        alias: ["q", "query"],
        type: "string",
        describe: "filter servers by name, type, or command/URL",
      })
      .option("type", {
        alias: "t",
        type: "string",
        choices: ["local", "remote"] as const,
        describe: "filter servers by type",
      })
      .option("enabled", {
        type: "boolean",
        describe: "filter servers by enabled status",
      }),
  handler: listMcp,
})

export const McpShowCommand = effectCmd({
  command: "show <name>",
  aliases: ["get"],
  describe: "show MCP server details",
  builder: (yargs: Argv) =>
    yargs
      .positional("name", {
        type: "string",
        describe: "name of the MCP server",
        demandOption: true,
      })
      .option("json", {
        type: "boolean",
        describe: "output JSON",
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write MCP server details to output file path",
      }),
  handler: showMcp,
})

export const McpCommand = cmd({
  command: "mcp",
  describe: "manage MCP (Model Context Protocol) servers",
  builder: (yargs) =>
    yargs
      .command(McpAddCommand)
      .command(McpListCommand)
      .command(McpShowCommand)
      .command(McpAuthCommand)
      .command(McpLogoutCommand)
      .command(McpDebugCommand)
      .command(McpEnableCommand)
      .command(McpDisableCommand)
      .command(McpRemoveCommand)
      .demandCommand(),
  async handler() {},
})

export const McpAuthCommand = effectCmd({
  command: "auth [name]",
  describe: "authenticate with an OAuth-enabled MCP server",
  builder: (yargs) =>
    yargs
      .positional("name", {
        describe: "name of the MCP server",
        type: "string",
      })
      .command(McpAuthListCommand),
  handler: Effect.fn("Cli.mcp.auth")(function* (args) {
    UI.empty()
    prompts.intro("MCP OAuth Authentication")

    const { config, auth } = yield* authState()
    const mcpServers = config.mcp ?? {}
    const servers = oauthServers(config)

    if (servers.length === 0) {
      prompts.log.warn("No OAuth-capable MCP servers configured")
      prompts.log.info("Remote MCP servers support OAuth by default. Add a remote server in opencode.json:")
      prompts.log.info(`
  "mcp": {
    "my-server": {
      "type": "remote",
      "url": "https://example.com/mcp"
    }
  }`)
      prompts.outro("Done")
      return
    }

    let serverName = args.name
    if (!serverName) {
      // Build options with auth status
      const options = servers.map(([name, cfg]) => {
        const authStatus = auth[name]
        const icon = getAuthStatusIcon(authStatus)
        const statusText = getAuthStatusText(authStatus)
        const url = cfg.url
        return {
          label: `${icon} ${name} (${statusText})`,
          value: name,
          hint: url,
        }
      })

      const selected = yield* Effect.promise(() =>
        prompts.select({
          message: "Select MCP server to authenticate",
          options,
        }),
      )
      if (prompts.isCancel(selected)) throw new UI.CancelledError()
      serverName = selected
    }

    const serverConfig = mcpServers[serverName]
    if (!serverConfig) {
      prompts.log.error(`MCP server not found: ${serverName}`)
      prompts.outro("Done")
      return
    }

    if (!isMcpRemote(serverConfig) || serverConfig.oauth === false) {
      prompts.log.error(`MCP server ${serverName} is not an OAuth-capable remote server`)
      prompts.outro("Done")
      return
    }

    // Check if already authenticated
    const authStatus = auth[serverName] ?? (yield* MCP.Service.use((mcp) => mcp.getAuthStatus(serverName)))
    if (authStatus === "authenticated") {
      const confirm = yield* Effect.promise(() =>
        prompts.confirm({
          message: `${serverName} already has valid credentials. Re-authenticate?`,
        }),
      )
      if (prompts.isCancel(confirm) || !confirm) {
        prompts.outro("Cancelled")
        return
      }
    } else if (authStatus === "expired") {
      prompts.log.warn(`${serverName} has expired credentials. Re-authenticating...`)
    }

    const spinner = prompts.spinner()
    spinner.start("Starting OAuth flow...")

    yield* MCP.Service.use((mcp) =>
      mcp.authenticate(serverName, (url) => {
        spinner.stop("Authorize in your browser:")
        prompts.log.info(url)
        spinner.start("Waiting for authorization...")
      }),
    ).pipe(
      Effect.tap((status) =>
        Effect.sync(() => {
          if (status.status === "connected") {
            spinner.stop("Authentication successful!")
          } else if (status.status === "needs_client_registration") {
            spinner.stop("Authentication failed", 1)
            prompts.log.error(status.error)
            prompts.log.info("Add clientId to your MCP server config:")
            prompts.log.info(`
  "mcp": {
    "${serverName}": {
      "type": "remote",
      "url": "${serverConfig.url}",
      "oauth": {
        "clientId": "your-client-id",
        "clientSecret": "your-client-secret"
      }
    }
  }`)
          } else if (status.status === "failed") {
            spinner.stop("Authentication failed", 1)
            prompts.log.error(status.error)
          } else {
            spinner.stop("Unexpected status: " + status.status, 1)
          }
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          spinner.stop("Authentication failed", 1)
          const error = Cause.squash(cause)
          prompts.log.error(error instanceof Error ? error.message : String(error))
        }),
      ),
    )

    prompts.outro("Done")
  }),
})

export type McpAuthListArgs = {
  json?: boolean
  output?: string
  search?: string
  status?: string
}

export const listMcpAuth = Effect.fn("Cli.mcp.auth.list")(function* (args: McpAuthListArgs = {}) {
  const { config, auth } = yield* authState()
  let servers = oauthServers(config)

  if (args.search) {
    const q = args.search.toLowerCase()
    servers = servers.filter(([name, sCfg]) => name.toLowerCase().includes(q) || sCfg.url.toLowerCase().includes(q))
  }

  if (args.status) {
    servers = servers.filter(([name]) => (auth[name] ?? "not_authenticated") === args.status)
  }

  if (args.json) {
    const jsonStr =
      JSON.stringify(
        servers.map(([name, serverConfig]) => ({
          name,
          type: serverConfig.type,
          url: serverConfig.url,
          authStatus: auth[name] ?? "not_authenticated",
        })),
        null,
        2,
      ) + EOL
    if (args.output) {
      const resolved = path.resolve(args.output)
      yield* Effect.promise(async () => {
        const fs = await import("fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        await fs.writeFile(resolved, jsonStr, "utf-8")
      })
      UI.println(`Wrote OAuth status list to ${resolved}`)
      return
    }
    process.stdout.write(jsonStr)
    return
  }

  if (args.output) {
    const lines: string[] = []
    lines.push("MCP OAuth Status")
    if (servers.length === 0) {
      lines.push("No OAuth-capable MCP servers configured")
    } else {
      for (const [name, serverConfig] of servers) {
        const authStatus = auth[name] ?? "not_authenticated"
        lines.push(`- ${name}: ${authStatus}`)
        lines.push(`    ${serverConfig.url}`)
      }
      lines.push(`${servers.length} OAuth-capable server(s)`)
    }
    const resolved = path.resolve(args.output)
    yield* Effect.promise(async () => {
      const fs = await import("fs/promises")
      await fs.mkdir(path.dirname(resolved), { recursive: true })
      await fs.writeFile(resolved, lines.join(EOL) + EOL, "utf-8")
    })
    UI.println(`Wrote OAuth status list to ${resolved}`)
    return
  }

  UI.empty()
  prompts.intro("MCP OAuth Status")

  if (servers.length === 0) {
    prompts.log.warn("No OAuth-capable MCP servers configured")
    prompts.outro("Done")
    return
  }

  for (const [name, serverConfig] of servers) {
    const authStatus = auth[name]
    const icon = getAuthStatusIcon(authStatus)
    const statusText = getAuthStatusText(authStatus)
    const url = serverConfig.url

    prompts.log.info(`${icon} ${name} ${UI.Style.TEXT_DIM}${statusText}\n    ${UI.Style.TEXT_DIM}${url}`)
  }

  prompts.outro(`${servers.length} OAuth-capable server(s)`)
})

export const McpAuthListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list OAuth-capable MCP servers and their auth status",
  builder: (yargs: Argv) =>
    yargs
      .option("json", {
        type: "boolean",
        describe: "output JSON",
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write OAuth status list to output file path",
      })
      .option("search", {
        alias: ["q", "query"],
        type: "string",
        describe: "filter servers by name or URL",
      })
      .option("status", {
        alias: "s",
        type: "string",
        choices: ["authenticated", "expired", "not_authenticated"] as const,
        describe: "filter servers by auth status",
      }),
  handler: listMcpAuth,
})

export const McpLogoutCommand = effectCmd({
  command: "logout [name]",
  describe: "remove OAuth credentials for an MCP server",
  builder: (yargs) =>
    yargs
      .positional("name", {
        describe: "name of the MCP server",
        type: "string",
      })
      .option("force", {
        alias: "f",
        describe: "do not exit non-zero if credentials or server not found",
        type: "boolean",
      })
      .option("json", {
        describe: "output JSON result",
        type: "boolean",
      })
      .option("output", {
        alias: "o",
        describe: "write logout result to output file path",
        type: "string",
      }),
  handler: Effect.fn("Cli.mcp.logout")(function* (args: {
    name?: string
    force?: boolean
    json?: boolean
    output?: string
  }) {
    const credentials = yield* McpAuth.Service.use((auth) => auth.all())
    const serverNames = Object.keys(credentials)

    const writeResult = (payload: { ok: boolean; name?: string; removed: boolean; message?: string; error?: string }) =>
      Effect.gen(function* () {
        if (args.json) {
          const jsonStr = JSON.stringify(payload, null, 2) + EOL
          if (args.output) {
            const resolved = path.resolve(args.output)
            yield* Effect.promise(async () => {
              const fs = await import("fs/promises")
              await fs.mkdir(path.dirname(resolved), { recursive: true })
              await fs.writeFile(resolved, jsonStr, "utf-8")
            })
          }
          process.stdout.write(jsonStr)
          if (!payload.ok && !args.force) process.exitCode = 1
          return
        }
        if (args.output) {
          const resolved = path.resolve(args.output)
          yield* Effect.promise(async () => {
            const fs = await import("fs/promises")
            await fs.mkdir(path.dirname(resolved), { recursive: true })
            await fs.writeFile(resolved, (payload.message || payload.error || "") + EOL, "utf-8")
          })
        }
        if (!payload.ok) {
          if (args.force) {
            UI.println(payload.message || payload.error || "No credentials found")
          } else {
            UI.empty()
            prompts.intro("MCP OAuth Logout")
            prompts.log.error(payload.error || "Failed")
            prompts.outro("Done")
            process.exitCode = 1
          }
          return
        }
        UI.empty()
        prompts.intro("MCP OAuth Logout")
        prompts.log.success(payload.message || `Removed OAuth credentials for ${payload.name}`)
        prompts.outro("Done")
      })

    if (!args.name && !process.stdin.isTTY) {
      if (args.json) {
        return yield* writeResult({
          ok: false,
          error: "Server name is required in non-interactive mode",
          removed: false,
        })
      }
      return yield* fail("Server name is required in non-interactive mode. Specify a server name.")
    }

    if (serverNames.length === 0) {
      if (args.force) {
        return yield* writeResult({
          ok: true,
          name: args.name,
          removed: false,
          message: "No MCP OAuth credentials stored",
        })
      }
      return yield* writeResult({
        ok: false,
        name: args.name,
        removed: false,
        error: "No MCP OAuth credentials stored",
      })
    }

    let serverName = args.name
    if (!serverName) {
      const selected = yield* Effect.promise(() =>
        prompts.select({
          message: "Select MCP server to logout",
          options: serverNames.map((name) => {
            const entry = credentials[name]
            const hasTokens = !!entry.tokens
            const hasClient = !!entry.clientInfo
            let hint = ""
            if (hasTokens && hasClient) hint = "tokens + client"
            else if (hasTokens) hint = "tokens"
            else if (hasClient) hint = "client registration"
            return {
              label: name,
              value: name,
              hint,
            }
          }),
        }),
      )
      if (prompts.isCancel(selected)) throw new UI.CancelledError()
      serverName = selected
    }

    if (!credentials[serverName]) {
      if (args.force) {
        return yield* writeResult({
          ok: true,
          name: serverName,
          removed: false,
          message: `No credentials found for: ${serverName}`,
        })
      }
      return yield* writeResult({
        ok: false,
        name: serverName,
        removed: false,
        error: `No credentials found for: ${serverName}`,
      })
    }

    yield* MCP.Service.use((mcp) => mcp.removeAuth(serverName))
    return yield* writeResult({
      ok: true,
      name: serverName,
      removed: true,
      message: `Removed OAuth credentials for ${serverName}`,
    })
  }),
})

async function resolveConfigPath(baseDir: string, global = false) {
  // Check for existing config files (prefer .jsonc over .json, check .opencode/ subdirectory too)
  const candidates = [path.join(baseDir, "opencode.json"), path.join(baseDir, "opencode.jsonc")]

  if (!global) {
    candidates.push(path.join(baseDir, ".opencode", "opencode.json"), path.join(baseDir, ".opencode", "opencode.jsonc"))
  }

  for (const candidate of candidates) {
    if (await Filesystem.exists(candidate)) {
      return candidate
    }
  }

  if (!global && (await Filesystem.isDir(path.join(baseDir, ".opencode")))) {
    return path.join(baseDir, ".opencode", "opencode.json")
  }

  // Default to opencode.json if none exist
  return candidates[0]
}

async function addMcpToConfig(name: string, mcpConfig: ConfigMCPV1.Info, configPath: string) {
  let text = "{}"
  if (await Filesystem.exists(configPath)) {
    text = await Filesystem.readText(configPath)
  }

  // Use jsonc-parser to modify while preserving comments
  const edits = modify(text, ["mcp", name], mcpConfig, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  })
  const result = applyEdits(text, edits)

  await Filesystem.write(configPath, result)

  return configPath
}

export const McpAddCommand = effectCmd({
  command: "add [name]",
  describe: "add an MCP server",
  builder: (yargs) =>
    yargs
      .positional("name", {
        describe: "name of the MCP server",
        type: "string",
      })
      .option("url", {
        describe: "URL for a remote MCP server",
        type: "string",
      })
      .option("env", {
        describe: "environment variable for a local MCP server (KEY=VALUE)",
        type: "string",
        array: true,
      })
      .option("header", {
        describe: "HTTP header for a remote MCP server (KEY=VALUE)",
        type: "string",
        array: true,
      })
      .option("scope", {
        describe: "configuration target scope (project or global)",
        choices: ["project", "global"] as const,
        type: "string",
      })
      .option("global", {
        alias: ["g"],
        describe: "add to global config (equivalent to --scope global)",
        type: "boolean",
      })
      .option("project", {
        alias: ["p"],
        describe: "add to project config (equivalent to --scope project)",
        type: "boolean",
      })
      .option("json", {
        type: "boolean",
        describe: "output JSON",
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write MCP server add result to output file path",
      }),
  handler: Effect.fn("Cli.mcp.add")(function* (args) {
    const maybeCtx = yield* InstanceRef
    if (!maybeCtx) return yield* Effect.die("InstanceRef not provided")
    const ctx = maybeCtx
    const projectDir = ctx.project.vcs === "git" && ctx.worktree !== "/" ? ctx.worktree : ctx.directory
    yield* Effect.promise(async () => {
      const isGlobal = Boolean(args.global || args.scope === "global")
      const isProject = Boolean(args.project || args.scope === "project")
      if (isGlobal && isProject) {
        throw new Error("Cannot specify both global and project scope")
      }

      const command = args["--"] ?? []
      if (!args.name && (args.url || args.env?.length || args.header?.length || command.length)) {
        throw new Error("A server name is required for non-interactive MCP configuration")
      }
      if (args.name) {
        if (!!args.url === !!command.length) {
          throw new Error("Provide either --url <url> or a command after --")
        }
        if (args.url && !URL.canParse(args.url)) {
          throw new Error(`Invalid URL: ${args.url}`)
        }
        if (args.url && args.env?.length) {
          throw new Error("--env is only valid for local MCP servers")
        }
        if (command.length && args.header?.length) {
          throw new Error("--header is only valid for remote MCP servers")
        }

        const entries = (values: string[], kind: string) =>
          Object.fromEntries(
            values.map((entry) => {
              const index = entry.indexOf("=")
              if (index < 1) throw new Error(`Invalid ${kind}: ${entry}. Expected KEY=VALUE`)
              return [entry.slice(0, index), entry.slice(index + 1)]
            }),
          )
        const environment = entries(args.env ?? [], "environment variable")
        const headers = entries(args.header ?? [], "HTTP header")
        const mcpConfig: ConfigMCPV1.Info = args.url
          ? {
              type: "remote",
              url: args.url,
              ...(Object.keys(headers).length ? { headers } : {}),
            }
          : {
              type: "local",
              command,
              ...(Object.keys(environment).length ? { environment } : {}),
            }

        const configPath = isProject
          ? await resolveConfigPath(projectDir, false)
          : await resolveConfigPath(Global.Path.config, true)
        await addMcpToConfig(args.name, mcpConfig, configPath)
        const summaryPayload = {
          ok: true,
          name: args.name,
          type: mcpConfig.type,
          file: configPath,
          config: mcpConfig,
        }
        const summaryText = `MCP server "${args.name}" added to ${configPath}`

        if (args.output) {
          const resolved = path.resolve(args.output)
          const fs = await import("fs/promises")
          await fs.mkdir(path.dirname(resolved), { recursive: true })
          if (args.json) {
            await fs.writeFile(resolved, JSON.stringify(summaryPayload, null, 2) + EOL, "utf-8")
          } else {
            await fs.writeFile(resolved, summaryText + EOL, "utf-8")
          }
          UI.println(`Wrote MCP add result to ${resolved}`)
          return
        }

        if (args.json) {
          process.stdout.write(JSON.stringify(summaryPayload, null, 2) + EOL)
          return
        }

        prompts.log.success(summaryText)
        return
      }

      UI.empty()
      prompts.intro("Add MCP server")

      const project = ctx.project

      // Resolve config paths eagerly for hints
      const [projectConfigPath, globalConfigPath] = await Promise.all([
        resolveConfigPath(projectDir),
        resolveConfigPath(Global.Path.config, true),
      ])

      // Determine scope
      let configPath = globalConfigPath
      if (isProject) {
        configPath = projectConfigPath
      } else if (isGlobal) {
        configPath = globalConfigPath
      } else if (project.vcs === "git") {
        const scopeResult = await prompts.select({
          message: "Location",
          options: [
            {
              label: "Current project",
              value: projectConfigPath,
              hint: projectConfigPath,
            },
            {
              label: "Global",
              value: globalConfigPath,
              hint: globalConfigPath,
            },
          ],
        })
        if (prompts.isCancel(scopeResult)) throw new UI.CancelledError()
        configPath = scopeResult
      }

      const name = await prompts.text({
        message: "Enter MCP server name",
        validate: (x) => (x && x.length > 0 ? undefined : "Required"),
      })
      if (prompts.isCancel(name)) throw new UI.CancelledError()

      const type = await prompts.select({
        message: "Select MCP server type",
        options: [
          {
            label: "Local",
            value: "local",
            hint: "Run a local command",
          },
          {
            label: "Remote",
            value: "remote",
            hint: "Connect to a remote URL",
          },
        ],
      })
      if (prompts.isCancel(type)) throw new UI.CancelledError()

      if (type === "local") {
        const command = await prompts.text({
          message: "Enter command to run",
          placeholder: "e.g., lmplayer x @modelcontextprotocol/server-filesystem",
          validate: (x) => (x && x.length > 0 ? undefined : "Required"),
        })
        if (prompts.isCancel(command)) throw new UI.CancelledError()

        const mcpConfig: ConfigMCPV1.Info = {
          type: "local",
          command: command.split(" "),
        }

        await addMcpToConfig(name, mcpConfig, configPath)
        prompts.log.success(`MCP server "${name}" added to ${configPath}`)
        prompts.outro("MCP server added successfully")
        return
      }

      if (type === "remote") {
        const url = await prompts.text({
          message: "Enter MCP server URL",
          placeholder: "e.g., https://example.com/mcp",
          validate: (x) => {
            if (!x) return "Required"
            if (x.length === 0) return "Required"
            const isValid = URL.canParse(x)
            return isValid ? undefined : "Invalid URL"
          },
        })
        if (prompts.isCancel(url)) throw new UI.CancelledError()

        const useOAuth = await prompts.confirm({
          message: "Does this server require OAuth authentication?",
          initialValue: false,
        })
        if (prompts.isCancel(useOAuth)) throw new UI.CancelledError()

        let mcpConfig: ConfigMCPV1.Info

        if (useOAuth) {
          const hasClientId = await prompts.confirm({
            message: "Do you have a pre-registered client ID?",
            initialValue: false,
          })
          if (prompts.isCancel(hasClientId)) throw new UI.CancelledError()

          if (hasClientId) {
            const clientId = await prompts.text({
              message: "Enter client ID",
              validate: (x) => (x && x.length > 0 ? undefined : "Required"),
            })
            if (prompts.isCancel(clientId)) throw new UI.CancelledError()

            const hasSecret = await prompts.confirm({
              message: "Do you have a client secret?",
              initialValue: false,
            })
            if (prompts.isCancel(hasSecret)) throw new UI.CancelledError()

            let clientSecret: string | undefined
            if (hasSecret) {
              const secret = await prompts.password({
                message: "Enter client secret",
              })
              if (prompts.isCancel(secret)) throw new UI.CancelledError()
              clientSecret = secret
            }

            mcpConfig = {
              type: "remote",
              url,
              oauth: {
                clientId,
                ...(clientSecret && { clientSecret }),
              },
            }
          } else {
            mcpConfig = {
              type: "remote",
              url,
              oauth: {},
            }
          }
        } else {
          mcpConfig = {
            type: "remote",
            url,
          }
        }

        await addMcpToConfig(name, mcpConfig, configPath)
        const summaryPayload = {
          ok: true,
          name,
          type: mcpConfig.type,
          file: configPath,
          config: mcpConfig,
        }
        const summaryText = `MCP server "${name}" added to ${configPath}`

        if (args.output) {
          const resolved = path.resolve(args.output)
          const fs = await import("fs/promises")
          await fs.mkdir(path.dirname(resolved), { recursive: true })
          if (args.json) {
            await fs.writeFile(resolved, JSON.stringify(summaryPayload, null, 2) + EOL, "utf-8")
          } else {
            await fs.writeFile(resolved, summaryText + EOL, "utf-8")
          }
          UI.println(`Wrote MCP add result to ${resolved}`)
          return
        }

        if (args.json) {
          process.stdout.write(JSON.stringify(summaryPayload, null, 2) + EOL)
          return
        }

        prompts.log.success(summaryText)
      }

      prompts.outro("MCP server added successfully")
    })
  }),
})

export type McpDebugArgs = {
  name: string
  output?: string
  json?: boolean
}

export interface McpDebugTokenInfo {
  accessTokenMasked?: string
  expiresAt?: string
  isExpired?: boolean
  hasRefreshToken?: boolean
}

export interface McpDebugClientInfo {
  clientId?: string
  clientSecretExpiresAt?: string
  hasDynamicRegistration?: boolean
}

export interface McpDebugHttpInfo {
  status?: number
  statusText?: string
  wwwAuthenticate?: string
  requiresOAuth?: boolean
  serverInfo?: Record<string, any>
  body?: string
  error?: string
}

export interface McpDebugResult {
  server: string
  found: boolean
  isRemote?: boolean
  oauthExplicitlyDisabled?: boolean
  url?: string
  authStatus?: string
  authStatusText?: string
  tokens?: McpDebugTokenInfo
  clientInfo?: McpDebugClientInfo
  http?: McpDebugHttpInfo
  connectionSuccessful?: boolean
  oauthFlowTriggered?: boolean
  error?: string
}

export function buildMcpDebugResult(opts: Partial<McpDebugResult> & { server: string; found: boolean }): McpDebugResult {
  return {
    server: opts.server,
    found: opts.found,
    ...(opts.isRemote !== undefined && { isRemote: opts.isRemote }),
    ...(opts.oauthExplicitlyDisabled !== undefined && { oauthExplicitlyDisabled: opts.oauthExplicitlyDisabled }),
    ...(opts.url && { url: opts.url }),
    ...(opts.authStatus && { authStatus: opts.authStatus }),
    ...(opts.authStatusText && { authStatusText: opts.authStatusText }),
    ...(opts.tokens && { tokens: opts.tokens }),
    ...(opts.clientInfo && { clientInfo: opts.clientInfo }),
    ...(opts.http && { http: opts.http }),
    ...(opts.connectionSuccessful !== undefined && { connectionSuccessful: opts.connectionSuccessful }),
    ...(opts.oauthFlowTriggered !== undefined && { oauthFlowTriggered: opts.oauthFlowTriggered }),
    ...(opts.error && { error: opts.error }),
  }
}

export function formatMcpDebugText(result: McpDebugResult): string[] {
  const lines: string[] = []
  lines.push(`MCP Server Debug: ${result.server}`)
  if (!result.found) {
    lines.push(`  Error: MCP server not found: ${result.server}`)
    return lines
  }
  if (result.isRemote === false) {
    lines.push(`  Error: MCP server ${result.server} is not a remote server`)
    return lines
  }
  if (result.url) {
    lines.push(`  URL: ${result.url}`)
  }
  if (result.oauthExplicitlyDisabled) {
    lines.push(`  Warning: MCP server ${result.server} has OAuth explicitly disabled`)
    return lines
  }
  if (result.authStatusText) {
    lines.push(`  Auth status: ${result.authStatusText}`)
  }
  if (result.tokens) {
    if (result.tokens.accessTokenMasked) {
      lines.push(`  Access token: ${result.tokens.accessTokenMasked}`)
    }
    if (result.tokens.expiresAt) {
      lines.push(`  Expires: ${result.tokens.expiresAt}${result.tokens.isExpired ? " (EXPIRED)" : ""}`)
    }
    if (result.tokens.hasRefreshToken) {
      lines.push(`  Refresh token: present`)
    }
  }
  if (result.clientInfo) {
    if (result.clientInfo.clientId) {
      lines.push(`  Client ID: ${result.clientInfo.clientId}`)
    }
    if (result.clientInfo.clientSecretExpiresAt) {
      lines.push(`  Client secret expires: ${result.clientInfo.clientSecretExpiresAt}`)
    }
    if (result.clientInfo.hasDynamicRegistration) {
      lines.push(`  Dynamic registration: will be attempted`)
    }
  }
  if (result.http) {
    if (result.http.status !== undefined) {
      const statusLine = `${result.http.status} ${result.http.statusText ?? ""}`.trim()
      lines.push(`  HTTP response: ${statusLine}`)
    }
    if (result.http.wwwAuthenticate) {
      lines.push(`  WWW-Authenticate: ${result.http.wwwAuthenticate}`)
    }
    if (result.http.requiresOAuth) {
      lines.push(`  OAuth required: yes (401 response)`)
    }
    if (result.http.serverInfo) {
      lines.push(`  Server info: ${JSON.stringify(result.http.serverInfo)}`)
    }
    if (result.http.error) {
      lines.push(`  Connection error: ${result.http.error}`)
    }
  }
  if (result.connectionSuccessful) {
    lines.push(`  Connection: successful`)
  }
  if (result.oauthFlowTriggered) {
    lines.push(`  OAuth flow: triggered`)
  }
  if (result.error && !result.http?.error) {
    lines.push(`  Error: ${result.error}`)
  }
  return lines
}

export async function writeMcpDebugOutputFile(output: string, result: McpDebugResult, isJson: boolean) {
  const resolved = path.resolve(output)
  const fs = await import("fs/promises")
  await fs.mkdir(path.dirname(resolved), { recursive: true })
  const content =
    output.endsWith(".json") || isJson
      ? JSON.stringify(result, null, 2) + EOL
      : formatMcpDebugText(result).join(EOL) + EOL
  await fs.writeFile(resolved, content, "utf-8")
  if (!isJson) {
    UI.println(`Wrote MCP debug report to ${resolved}`)
  }
}

export const debugMcp = Effect.fn("Cli.mcp.debug")(function* (args: McpDebugArgs) {
  const config = yield* Config.Service.use((cfg) => cfg.get())
  const mcp = yield* MCP.Service
  const auth = yield* McpAuth.Service
  const serverConfig = config.mcp?.[args.name]
  const authInfo =
    serverConfig && isMcpRemote(serverConfig) && serverConfig.oauth !== false
      ? yield* Effect.all({
          authStatus: mcp.getAuthStatus(args.name),
          entry: auth.get(args.name),
        })
      : undefined

  yield* Effect.promise(async () => {
    const isJson = Boolean(args.json)
    const serverName = args.name

    if (!isJson) {
      UI.empty()
      prompts.intro("MCP OAuth Debug")
    }

    if (!serverConfig) {
      const result = buildMcpDebugResult({
        server: serverName,
        found: false,
        error: `MCP server not found: ${serverName}`,
      })
      if (isJson) {
        process.stdout.write(JSON.stringify(result, null, 2) + EOL)
      } else {
        prompts.log.error(`MCP server not found: ${serverName}`)
        prompts.outro("Done")
      }
      if (args.output) {
        await writeMcpDebugOutputFile(args.output, result, isJson)
      }
      return
    }

    if (!isMcpRemote(serverConfig)) {
      const result = buildMcpDebugResult({
        server: serverName,
        found: true,
        isRemote: false,
        error: `MCP server ${serverName} is not a remote server`,
      })
      if (isJson) {
        process.stdout.write(JSON.stringify(result, null, 2) + EOL)
      } else {
        prompts.log.error(`MCP server ${serverName} is not a remote server`)
        prompts.outro("Done")
      }
      if (args.output) {
        await writeMcpDebugOutputFile(args.output, result, isJson)
      }
      return
    }

    if (serverConfig.oauth === false) {
      const result = buildMcpDebugResult({
        server: serverName,
        found: true,
        isRemote: true,
        oauthExplicitlyDisabled: true,
        url: serverConfig.url,
      })
      if (isJson) {
        process.stdout.write(JSON.stringify(result, null, 2) + EOL)
      } else {
        prompts.log.warn(`MCP server ${serverName} has OAuth explicitly disabled`)
        prompts.outro("Done")
      }
      if (args.output) {
        await writeMcpDebugOutputFile(args.output, result, isJson)
      }
      return
    }

    const { authStatus, entry } = authInfo!
    const authStatusText = getAuthStatusText(authStatus)
    const authStatusIcon = getAuthStatusIcon(authStatus)

    if (!isJson) {
      prompts.log.info(`Server: ${serverName}`)
      prompts.log.info(`URL: ${serverConfig.url}`)
      prompts.log.info(`Auth status: ${authStatusIcon} ${authStatusText}`)
    }

    let tokenInfo: McpDebugTokenInfo | undefined
    if (entry?.tokens) {
      const accessTokenMasked =
        entry.tokens.accessToken.length > 8
          ? `${entry.tokens.accessToken.slice(0, 4)}***${entry.tokens.accessToken.slice(-4)}`
          : "***"
      const isExpired = entry.tokens.expiresAt ? entry.tokens.expiresAt < Date.now() / 1000 : undefined
      const expiresAt = entry.tokens.expiresAt ? new Date(entry.tokens.expiresAt * 1000).toISOString() : undefined
      tokenInfo = {
        accessTokenMasked,
        expiresAt,
        isExpired,
        hasRefreshToken: Boolean(entry.tokens.refreshToken),
      }
      if (!isJson) {
        prompts.log.info(`  Access token: ${accessTokenMasked}`)
        if (expiresAt) {
          prompts.log.info(`  Expires: ${expiresAt} ${isExpired ? "(EXPIRED)" : ""}`)
        }
        if (entry.tokens.refreshToken) {
          prompts.log.info(`  Refresh token: present`)
        }
      }
    }

    let clientInfoResult: McpDebugClientInfo | undefined
    if (entry?.clientInfo) {
      const clientSecretExpiresAt = entry.clientInfo.clientSecretExpiresAt
        ? new Date(entry.clientInfo.clientSecretExpiresAt * 1000).toISOString()
        : undefined
      clientInfoResult = {
        clientId: entry.clientInfo.clientId,
        clientSecretExpiresAt,
      }
      if (!isJson) {
        prompts.log.info(`  Client ID: ${entry.clientInfo.clientId}`)
        if (clientSecretExpiresAt) {
          prompts.log.info(`  Client secret expires: ${clientSecretExpiresAt}`)
        }
      }
    }

    let spinner: ReturnType<typeof prompts.spinner> | undefined
    if (!isJson) {
      spinner = prompts.spinner()
      spinner.start("Testing connection...")
    }

    let httpInfo: McpDebugHttpInfo = {}
    let connectionSuccessful = false
    let oauthFlowTriggered = false

    try {
      const response = await fetch(serverConfig.url, {
        method: "POST",
        headers: {
          ...serverConfig.headers,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "lmplayer-debug", version: InstallationVersion },
          },
          id: 1,
        }),
      })

      httpInfo.status = response.status
      httpInfo.statusText = response.statusText

      if (spinner) {
        spinner.stop(`HTTP response: ${response.status} ${response.statusText}`)
      }

      const wwwAuth = response.headers.get("www-authenticate")
      if (wwwAuth) {
        httpInfo.wwwAuthenticate = wwwAuth
        if (!isJson) {
          prompts.log.info(`WWW-Authenticate: ${wwwAuth}`)
        }
      }

      if (response.status === 401) {
        httpInfo.requiresOAuth = true
        if (!isJson) {
          prompts.log.info("Initial unauthenticated check returned 401, so this server requires OAuth")
        }

        const oauthConfig = typeof serverConfig.oauth === "object" ? serverConfig.oauth : undefined
        const authProvider = new McpOAuthProvider(
          serverName,
          serverConfig.url,
          {
            clientId: oauthConfig?.clientId,
            clientSecret: oauthConfig?.clientSecret,
            scope: oauthConfig?.scope,
            redirectUri: oauthConfig?.redirectUri,
          },
          {
            onRedirect: async () => {},
          },
          auth,
        )

        if (!isJson) {
          prompts.log.info("Testing OAuth flow (without completing authorization)...")
        }

        const transport = new StreamableHTTPClientTransport(new URL(serverConfig.url), {
          authProvider,
          requestInit: serverConfig.headers ? { headers: serverConfig.headers } : undefined,
        })

        try {
          const client = new Client({
            name: "lmplayer-debug",
            version: InstallationVersion,
          })
          await client.connect(transport)
          connectionSuccessful = true
          if (!isJson) {
            prompts.log.success("Connection successful (already authenticated)")
          }
          await client.close()
        } catch (error) {
          if (error instanceof UnauthorizedError) {
            oauthFlowTriggered = true
            if (!isJson) {
              prompts.log.info(`OAuth flow triggered: ${error.message}`)
            }

            const cInfo = await authProvider.clientInformation()
            if (cInfo) {
              if (clientInfoResult) {
                clientInfoResult.clientId = cInfo.client_id
              } else {
                clientInfoResult = { clientId: cInfo.client_id }
              }
              if (!isJson) {
                prompts.log.info(`Client ID available: ${cInfo.client_id}`)
              }
            } else {
              if (clientInfoResult) {
                clientInfoResult.hasDynamicRegistration = true
              } else {
                clientInfoResult = { hasDynamicRegistration: true }
              }
              if (!isJson) {
                prompts.log.info("No client ID - dynamic registration will be attempted")
              }
            }
          } else {
            const msg = error instanceof Error ? error.message : String(error)
            httpInfo.error = msg
            if (!isJson) {
              prompts.log.error(`Connection error: ${msg}`)
            }
          }
        }
      } else if (response.status >= 200 && response.status < 300) {
        connectionSuccessful = true
        if (!isJson) {
          prompts.log.success("Server responded successfully (no auth required or already authenticated)")
        }
        const body = await response.text()
        try {
          const json = JSON.parse(body)
          if (json.result?.serverInfo) {
            httpInfo.serverInfo = json.result.serverInfo
            if (!isJson) {
              prompts.log.info(`Server info: ${JSON.stringify(json.result.serverInfo)}`)
            }
          }
        } catch {
          // Not JSON, ignore
        }
      } else {
        if (!isJson) {
          prompts.log.warn(`Unexpected status: ${response.status}`)
        }
        const body = await response.text().catch(() => "")
        if (body) {
          httpInfo.body = body.substring(0, 500)
          if (!isJson) {
            prompts.log.info(`Response body: ${body.substring(0, 500)}`)
          }
        }
      }
    } catch (error) {
      if (spinner) {
        spinner.stop("Connection failed", 1)
      }
      const msg = error instanceof Error ? error.message : String(error)
      httpInfo.error = msg
      if (!isJson) {
        prompts.log.error(`Error: ${msg}`)
      }
    }

    if (!isJson) {
      prompts.outro("Debug complete")
    }

    const result = buildMcpDebugResult({
      server: serverName,
      found: true,
      isRemote: true,
      url: serverConfig.url,
      authStatus: String(authStatus),
      authStatusText,
      tokens: tokenInfo,
      clientInfo: clientInfoResult,
      http: httpInfo,
      connectionSuccessful: connectionSuccessful || undefined,
      oauthFlowTriggered: oauthFlowTriggered || undefined,
      error: httpInfo.error,
    })

    if (isJson) {
      process.stdout.write(JSON.stringify(result, null, 2) + EOL)
    }

    if (args.output) {
      await writeMcpDebugOutputFile(args.output, result, isJson)
    }
  })
})

export const McpDebugCommand = effectCmd({
  command: "debug <name>",
  describe: "debug OAuth connection for an MCP server",
  builder: (yargs: Argv) =>
    yargs
      .positional("name", {
        describe: "name of the MCP server",
        type: "string",
        demandOption: true,
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write debug report to file path",
      })
      .option("json", {
        type: "boolean",
        describe: "output as JSON",
        default: false,
      }),
  handler: debugMcp,
})

async function hasMcpServer(name: string, configPath: string): Promise<boolean> {
  if (!(await Filesystem.exists(configPath))) return false
  try {
    const text = await Filesystem.readText(configPath)
    const json = parse(text)
    return (
      typeof json === "object" &&
      json !== null &&
      "mcp" in json &&
      typeof json.mcp === "object" &&
      json.mcp !== null &&
      name in json.mcp
    )
  } catch {
    return false
  }
}

async function setMcpEnabled(name: string, enabled: boolean, configPath: string) {
  let text = "{}"
  if (await Filesystem.exists(configPath)) {
    text = await Filesystem.readText(configPath)
  }
  const edits = modify(text, ["mcp", name, "enabled"], enabled, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  })
  const result = applyEdits(text, edits)
  await Filesystem.write(configPath, result)
  return configPath
}

const addMcpScopeOptions = <T>(yargs: Argv<T>) =>
  yargs
    .option("scope", {
      describe: "configuration target scope (project or global)",
      choices: ["project", "global"] as const,
      type: "string",
    })
    .option("global", {
      alias: ["g"],
      describe: "target global config (equivalent to --scope global)",
      type: "boolean",
    })
    .option("project", {
      alias: ["p"],
      describe: "target project config (equivalent to --scope project)",
      type: "boolean",
    })
    .check((argv) => {
      if (argv.project && argv.global) {
        throw new Error("Cannot specify both global and project scope")
      }
      if (argv.scope && (argv.project || argv.global)) {
        throw new Error("Cannot specify both --scope and --project/--global")
      }
      return true
    })

const makeMcpToggleCommand = (action: "enable" | "disable") =>
  effectCmd({
    command: `${action} <name>`,
    describe: `${action} a configured MCP server`,
    builder: (yargs) =>
      addMcpScopeOptions(
        yargs.positional("name", {
          describe: `name of the MCP server to ${action}`,
          type: "string",
          demandOption: true,
        }),
      )
        .option("json", {
          type: "boolean",
          describe: "output JSON",
        })
        .option("output", {
          alias: "o",
          type: "string",
          describe: `write ${action} result to output file path`,
        }),
    handler: Effect.fn(`Cli.mcp.${action}`)(function* (args: {
      name: string
      global?: boolean
      project?: boolean
      scope?: "project" | "global"
      json?: boolean
      output?: string
    }) {
      const maybeCtx = yield* InstanceRef
      if (!maybeCtx) return yield* Effect.die("InstanceRef not provided")
      const ctx = maybeCtx
      const projectDir = ctx.project.vcs === "git" && ctx.worktree !== "/" ? ctx.worktree : ctx.directory

      const isGlobal = Boolean(args.global || args.scope === "global")
      const isProject = Boolean(args.project || args.scope === "project")
      const enabled = action === "enable"

      const projectConfigPath = yield* Effect.promise(() => resolveConfigPath(projectDir, false))
      const globalConfigPath = yield* Effect.promise(() => resolveConfigPath(Global.Path.config, true))

      let targetPath: string
      if (isProject) {
        const has = yield* Effect.promise(() => hasMcpServer(args.name, projectConfigPath))
        if (!has) {
          return yield* fail(`MCP server "${args.name}" not found in project configuration (${projectConfigPath})`)
        }
        targetPath = projectConfigPath
      } else if (isGlobal) {
        const has = yield* Effect.promise(() => hasMcpServer(args.name, globalConfigPath))
        if (!has) {
          return yield* fail(`MCP server "${args.name}" not found in global configuration (${globalConfigPath})`)
        }
        targetPath = globalConfigPath
      } else {
        const hasProject = yield* Effect.promise(() => hasMcpServer(args.name, projectConfigPath))
        if (hasProject) {
          targetPath = projectConfigPath
        } else {
          const hasGlobal = yield* Effect.promise(() => hasMcpServer(args.name, globalConfigPath))
          if (hasGlobal) {
            targetPath = globalConfigPath
          } else {
            return yield* fail(`MCP server "${args.name}" not found in configuration`)
          }
        }
      }

      yield* Effect.promise(() => setMcpEnabled(args.name, enabled, targetPath))

      const summaryPayload = {
        ok: true,
        name: args.name,
        action,
        enabled,
        file: targetPath,
      }
      const summaryText = `MCP server "${args.name}" ${enabled ? "enabled" : "disabled"} in ${targetPath}`

      if (args.output) {
        const resolved = path.resolve(args.output)
        yield* Effect.promise(async () => {
          const fs = await import("fs/promises")
          await fs.mkdir(path.dirname(resolved), { recursive: true })
          if (args.json) {
            await fs.writeFile(resolved, JSON.stringify(summaryPayload, null, 2) + EOL, "utf-8")
          } else {
            await fs.writeFile(resolved, summaryText + EOL, "utf-8")
          }
        })
        UI.println(`Wrote ${action} result to ${resolved}`)
        return
      }

      if (args.json) {
        process.stdout.write(JSON.stringify(summaryPayload, null, 2) + EOL)
        return
      }

      prompts.log.success(summaryText)
    }),
  })

export const McpEnableCommand = makeMcpToggleCommand("enable")
export const McpDisableCommand = makeMcpToggleCommand("disable")

async function removeMcpFromConfig(name: string, configPath: string) {
  if (!(await Filesystem.exists(configPath))) return configPath
  const text = await Filesystem.readText(configPath)
  const edits = modify(text, ["mcp", name], undefined, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  })
  const result = applyEdits(text, edits)
  await Filesystem.write(configPath, result)
  return configPath
}

export const McpRemoveCommand = effectCmd({
  command: "remove <name>",
  aliases: ["rm"],
  describe: "remove a configured MCP server",
  builder: (yargs) =>
    addMcpScopeOptions(
      yargs.positional("name", {
        describe: "name of the MCP server to remove",
        type: "string",
        demandOption: true,
      }),
    )
      .option("force", {
        alias: "f",
        type: "boolean",
        describe: "do not exit non-zero if server is not found",
      })
      .option("json", {
        type: "boolean",
        describe: "output JSON",
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write removal result to output file path",
      }),
  handler: Effect.fn("Cli.mcp.remove")(function* (args: {
    name: string
    global?: boolean
    project?: boolean
    scope?: "project" | "global"
    force?: boolean
    json?: boolean
    output?: string
  }) {
    const maybeCtx = yield* InstanceRef
    if (!maybeCtx) return yield* Effect.die("InstanceRef not provided")
    const ctx = maybeCtx
    const projectDir = ctx.project.vcs === "git" && ctx.worktree !== "/" ? ctx.worktree : ctx.directory

    const isGlobal = Boolean(args.global || args.scope === "global")
    const isProject = Boolean(args.project || args.scope === "project")

    const projectConfigPath = yield* Effect.promise(() => resolveConfigPath(projectDir, false))
    const globalConfigPath = yield* Effect.promise(() => resolveConfigPath(Global.Path.config, true))

    const handleNotFound = (message: string) =>
      Effect.gen(function* () {
        if (!args.force) {
          return yield* fail(message)
        }
        const failPayload = {
          ok: false,
          name: args.name,
          message,
        }
        if (args.output) {
          const resolved = path.resolve(args.output)
          yield* Effect.promise(async () => {
            const fs = await import("fs/promises")
            await fs.mkdir(path.dirname(resolved), { recursive: true })
            if (args.json) {
              await fs.writeFile(resolved, JSON.stringify(failPayload, null, 2) + EOL, "utf-8")
            } else {
              await fs.writeFile(resolved, failPayload.message + EOL, "utf-8")
            }
          })
          UI.println(`Wrote removal result to ${resolved}`)
          return
        }
        if (args.json) {
          process.stdout.write(JSON.stringify(failPayload, null, 2) + EOL)
          return
        }
        UI.println(failPayload.message)
      })

    let targetPath: string
    if (isProject) {
      const has = yield* Effect.promise(() => hasMcpServer(args.name, projectConfigPath))
      if (!has) {
        return yield* handleNotFound(`MCP server "${args.name}" not found in project configuration (${projectConfigPath})`)
      }
      targetPath = projectConfigPath
    } else if (isGlobal) {
      const has = yield* Effect.promise(() => hasMcpServer(args.name, globalConfigPath))
      if (!has) {
        return yield* handleNotFound(`MCP server "${args.name}" not found in global configuration (${globalConfigPath})`)
      }
      targetPath = globalConfigPath
    } else {
      const hasProject = yield* Effect.promise(() => hasMcpServer(args.name, projectConfigPath))
      if (hasProject) {
        targetPath = projectConfigPath
      } else {
        const hasGlobal = yield* Effect.promise(() => hasMcpServer(args.name, globalConfigPath))
        if (hasGlobal) {
          targetPath = globalConfigPath
        } else {
          return yield* handleNotFound(`MCP server "${args.name}" not found in configuration`)
        }
      }
    }

    yield* Effect.promise(() => removeMcpFromConfig(args.name, targetPath))

    const summaryPayload = {
      ok: true,
      name: args.name,
      file: targetPath,
      removed: true,
    }
    const summaryText = `MCP server "${args.name}" removed from ${targetPath}`

    if (args.output) {
      const resolved = path.resolve(args.output)
      yield* Effect.promise(async () => {
        const fs = await import("fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        if (args.json) {
          await fs.writeFile(resolved, JSON.stringify(summaryPayload, null, 2) + EOL, "utf-8")
        } else {
          await fs.writeFile(resolved, summaryText + EOL, "utf-8")
        }
      })
      UI.println(`Wrote removal result to ${resolved}`)
      return
    }

    if (args.json) {
      process.stdout.write(JSON.stringify(summaryPayload, null, 2) + EOL)
      return
    }

    prompts.log.success(summaryText)
  }),
})

