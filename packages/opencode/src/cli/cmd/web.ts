import { Effect } from "effect"
import { UI } from "../ui"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@opencode-ai/core/flag/flag"
import open from "open"
import { networkInterfaces, EOL } from "os"
import path from "path"

export function getNetworkIPs(): string[] {
  const nets = networkInterfaces()
  const results: string[] = []

  for (const name of Object.keys(nets)) {
    const net = nets[name]
    if (!net) continue

    for (const netInfo of net) {
      // Skip internal and non-IPv4 addresses
      if (netInfo.internal || netInfo.family !== "IPv4") continue

      // Skip Docker bridge networks (typically 172.x.x.x)
      if (netInfo.address.startsWith("172.")) continue

      results.push(netInfo.address)
    }
  }

  return results
}

export interface WebServerInfo {
  url: string
  hostname: string
  port: number
  localUrl?: string
  networkUrls: string[]
  mdns?: boolean
  mdnsUrl?: string
  openedBrowser: boolean
}

export function buildWebServerInfo(opts: {
  hostname: string
  port: number
  url?: string
  networkIPs?: string[]
  mdns?: boolean
  mdnsDomain?: string
  openedBrowser?: boolean
}): WebServerInfo {
  const isAllInterfaces = opts.hostname === "0.0.0.0"
  const localUrl = `http://localhost:${opts.port}`
  const primaryUrl = isAllInterfaces ? localUrl : (opts.url ?? `http://${opts.hostname}:${opts.port}`)
  const networkUrls = (opts.networkIPs ?? []).map((ip) => `http://${ip}:${opts.port}`)
  const mdnsUrl = opts.mdns ? `http://${opts.mdnsDomain ?? "opencode.local"}:${opts.port}` : undefined

  return {
    url: primaryUrl,
    hostname: opts.hostname,
    port: opts.port,
    ...(isAllInterfaces && { localUrl }),
    networkUrls,
    mdns: opts.mdns ?? false,
    ...(mdnsUrl && { mdnsUrl }),
    openedBrowser: opts.openedBrowser ?? false,
  }
}

export function formatWebServerInfoText(info: WebServerInfo): string[] {
  const lines: string[] = []
  lines.push(`lmplayer web interface started`)
  if (info.localUrl) {
    lines.push(`  Local access:   ${info.localUrl}`)
  } else {
    lines.push(`  Web interface:  ${info.url}`)
  }
  for (const netUrl of info.networkUrls) {
    lines.push(`  Network access: ${netUrl}`)
  }
  if (info.mdnsUrl) {
    lines.push(`  mDNS:           ${info.mdnsUrl}`)
  }
  lines.push(`  Browser:        ${info.openedBrowser ? "opened" : "skipped"}`)
  return lines
}

export async function writeWebServerOutputFile(output: string, info: WebServerInfo, isJson: boolean) {
  const resolved = path.resolve(output)
  const fs = await import("fs/promises")
  await fs.mkdir(path.dirname(resolved), { recursive: true })
  const content =
    output.endsWith(".json") || isJson
      ? JSON.stringify(info, null, 2) + EOL
      : formatWebServerInfoText(info).join(EOL) + EOL
  await fs.writeFile(resolved, content, "utf-8")
  if (!isJson) {
    UI.println(`Wrote web server details to ${resolved}`)
  }
}

export const WebCommand = effectCmd({
  command: "web",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .option("open", {
        type: "boolean",
        describe: "open web interface in default browser",
        default: true,
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write web server details to file path",
      })
      .option("json", {
        type: "boolean",
        describe: "output server details as JSON",
        default: false,
      }),
  describe: "start lmplayer server and open web interface",
  // Server loads instances per-request via x-opencode-directory header — no
  // ambient project InstanceContext needed at startup.
  instance: false,
  handler: Effect.fn("Cli.web")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    if (!Flag.OPENCODE_SERVER_PASSWORD && !args.json) {
      UI.println(UI.Style.TEXT_WARNING_BOLD + "!  OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))

    const isJson = Boolean(args.json)
    const shouldOpen = args.open !== false
    const output = args.output
    const networkIPs = opts.hostname === "0.0.0.0" ? getNetworkIPs() : []
    let opened = false

    if (shouldOpen) {
      const openTarget = opts.hostname === "0.0.0.0" ? `http://localhost:${server.port}` : server.url.toString()
      open(openTarget).catch(() => {})
      opened = true
    }

    const info = buildWebServerInfo({
      hostname: opts.hostname,
      port: server.port,
      url: server.url?.toString(),
      networkIPs,
      mdns: opts.mdns,
      mdnsDomain: opts.mdnsDomain,
      openedBrowser: opened,
    })

    if (isJson) {
      process.stdout.write(JSON.stringify(info, null, 2) + EOL)
    } else {
      UI.empty()
      UI.println(UI.logo("  "))
      UI.empty()

      if (opts.hostname === "0.0.0.0") {
        UI.println(UI.Style.TEXT_INFO_BOLD + "  Local access:      ", UI.Style.TEXT_NORMAL, `http://localhost:${server.port}`)
        if (networkIPs.length > 0) {
          for (const ip of networkIPs) {
            UI.println(
              UI.Style.TEXT_INFO_BOLD + "  Network access:    ",
              UI.Style.TEXT_NORMAL,
              `http://${ip}:${server.port}`,
            )
          }
        }
        if (opts.mdns) {
          UI.println(
            UI.Style.TEXT_INFO_BOLD + "  mDNS:              ",
            UI.Style.TEXT_NORMAL,
            `${opts.mdnsDomain}:${server.port}`,
          )
        }
      } else {
        UI.println(UI.Style.TEXT_INFO_BOLD + "  Web interface:    ", UI.Style.TEXT_NORMAL, server.url.toString())
      }
      if (!shouldOpen) {
        UI.println(UI.Style.TEXT_DIM + "  (Browser open skipped via --no-open)")
      }
    }

    if (output) {
      yield* Effect.promise(() => writeWebServerOutputFile(output, info, isJson))
    }

    yield* Effect.never
  }),
})
