import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk"
import { ServerAuth } from "@/server/auth"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { ACPProfile } from "@/acp/profile"
import path from "path"
import { EOL } from "os"

export interface AcpServerInfo {
  url: string
  hostname: string
  port: number
  cwd: string
  client: string
  pid: number
}

export function buildAcpServerInfo(opts: {
  hostname: string
  port: number
  cwd: string
  client?: string
  pid?: number
}): AcpServerInfo {
  return {
    url: `http://${opts.hostname}:${opts.port}`,
    hostname: opts.hostname,
    port: opts.port,
    cwd: opts.cwd,
    client: opts.client ?? "acp",
    pid: opts.pid ?? process.pid,
  }
}

export function formatAcpServerInfoText(info: AcpServerInfo): string[] {
  return [
    `ACP server started`,
    `  URL:      ${info.url}`,
    `  Host:     ${info.hostname}`,
    `  Port:     ${info.port}`,
    `  CWD:      ${info.cwd}`,
    `  Client:   ${info.client}`,
    `  PID:      ${info.pid}`,
  ]
}

export async function writeAcpServerOutputFile(output: string, info: AcpServerInfo, isJson: boolean = false) {
  const resolved = path.resolve(output)
  const fs = await import("fs/promises")
  await fs.mkdir(path.dirname(resolved), { recursive: true })
  const content =
    output.endsWith(".json") || isJson
      ? JSON.stringify(info, null, 2) + EOL
      : formatAcpServerInfoText(info).join(EOL) + EOL
  await fs.writeFile(resolved, content, "utf-8")
}

export const AcpCommand = effectCmd({
  command: "acp",
  describe: "start ACP (Agent Client Protocol) server",
  builder: (yargs) => {
    return withNetworkOptions(yargs)
      .option("cwd", {
        alias: ["dir", "directory", "d"],
        describe: "working directory",
        type: "string",
        default: process.cwd(),
      })
      .option("output", {
        alias: ["o"],
        type: "string",
        describe: "write ACP server details to file path",
      })
      .option("json", {
        type: "boolean",
        describe: "format output file as JSON",
        default: false,
      })
  },
  handler: Effect.fn("Cli.acp")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("@/server/server"))
    const { ACP } = yield* Effect.promise(() => import("@/acp/agent"))
    ACPProfile.mark("cli.acp.handler")
    process.env.OPENCODE_CLIENT = "acp"
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => ACPProfile.measure("cli.acp.server.listen", () => Server.listen(opts)))

    const outputFile = args.output || (args as any).o
    if (outputFile) {
      const cwd = args.cwd ?? (args as any).dir ?? (args as any).directory ?? (args as any).d ?? process.cwd()
      const info = buildAcpServerInfo({
        hostname: server.hostname,
        port: server.port,
        cwd,
        client: "acp",
        pid: process.pid,
      })
      yield* Effect.promise(() => writeAcpServerOutputFile(outputFile, info, Boolean(args.json)))
    }

    const sdk = createOpencodeClient({
      baseUrl: `http://${server.hostname}:${server.port}`,
      headers: ServerAuth.headers(),
    })

    const input = new WritableStream<Uint8Array>({
      write(chunk) {
        return new Promise<void>((resolve, reject) => {
          process.stdout.write(chunk, (err) => {
            if (err) {
              reject(err)
            } else {
              resolve()
            }
          })
        })
      },
    })
    const output = new ReadableStream<Uint8Array>({
      start(controller) {
        process.stdin.on("data", (chunk: Buffer) => {
          controller.enqueue(new Uint8Array(chunk))
        })
        process.stdin.on("end", () => controller.close())
        process.stdin.on("error", (err) => controller.error(err))
      },
    })

    const stream = ndJsonStream(input, output)
    const agent = ACP.init({ sdk })

    new AgentSideConnection((conn) => {
      ACPProfile.mark("cli.acp.connection.create")
      return agent.create(conn)
    }, stream)

    yield* Effect.logInfo("setup connection")
    process.stdin.resume()
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          process.stdin.on("end", () => resolve())
          process.stdin.on("error", reject)
        }),
    )
  }),
})
