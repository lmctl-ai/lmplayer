import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@opencode-ai/core/flag/flag"
import { EOL } from "os"
import path from "path"

export interface ServerInfo {
  url: string
  hostname: string
  port: number
}

export function buildServerInfo(opts: { hostname: string; port: number; url?: string }): ServerInfo {
  return {
    url: opts.url ?? `http://${opts.hostname}:${opts.port}`,
    hostname: opts.hostname,
    port: opts.port,
  }
}

export function formatServerInfoText(info: ServerInfo): string[] {
  return [`lmplayer server listening on ${info.url}`]
}

export async function writeServerOutputFile(output: string, info: ServerInfo, isJson: boolean) {
  const resolved = path.resolve(output)
  const fs = await import("fs/promises")
  await fs.mkdir(path.dirname(resolved), { recursive: true })
  const content =
    output.endsWith(".json") || isJson
      ? JSON.stringify(info, null, 2) + EOL
      : formatServerInfoText(info).join(EOL) + EOL
  await fs.writeFile(resolved, content, "utf-8")
  if (!isJson) {
    console.log(`Wrote server details to ${resolved}`)
  }
}

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write server details to file path",
      })
      .option("json", {
        type: "boolean",
        describe: "output server details as JSON",
        default: false,
      }),
  describe: "starts a headless lmplayer server",
  // Server loads instances per-request via x-opencode-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    const { gracefulShutdown } = yield* Effect.promise(() => import("../../server/execution-gate"))
    if (!Flag.OPENCODE_SERVER_PASSWORD && !args.json) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    const isJson = Boolean(args.json)
    const info = buildServerInfo({ hostname: server.hostname, port: server.port, url: server.url?.toString() })

    if (isJson) {
      process.stdout.write(JSON.stringify(info, null, 2) + EOL)
    } else {
      console.log(`lmplayer server listening on http://${server.hostname}:${server.port}`)
    }

    if (args.output) {
      yield* Effect.promise(() => writeServerOutputFile(args.output!, info, isJson))
    }

    // Graceful drain-then-exit: finish the in-flight run, then exit. Do NOT
    // interrupt the run (that path aborts it). process.once guards double-fire.
    process.once("SIGTERM", () => gracefulShutdown("SIGTERM"))
    process.once("SIGINT", () => gracefulShutdown("SIGINT"))

    yield* Effect.never
  }),
})
