import { cmd } from "./cmd"
import { UI } from "@/cli/ui"
import { errorMessage } from "@opencode-ai/tui/util/error"
import { validateSession } from "../tui/validate-session"
import { ServerAuth } from "@/server/auth"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import path from "path"
import { EOL } from "os"

export interface AttachSessionInfo {
  id: string
  title?: string
  parentID?: string
  created?: number
  updated?: number
}

export interface AttachCheckResult {
  url: string
  healthy: boolean
  version?: string
  authenticated: boolean
  directory?: string
  session?: AttachSessionInfo
  fork?: boolean
  continue?: boolean
  checkedAt: string
  error?: string
}

export function formatAttachCheckText(result: AttachCheckResult): string[] {
  const lines: string[] = []
  lines.push(`Server status: ${result.healthy ? "healthy" : "unhealthy"}`)
  lines.push(`  URL:           ${result.url}`)
  if (result.version) {
    lines.push(`  Version:       ${result.version}`)
  }
  lines.push(`  Authenticated: ${result.authenticated ? "yes" : "no"}`)
  if (result.directory) {
    lines.push(`  Directory:     ${result.directory}`)
  }
  if (result.session) {
    lines.push(`  Session:       ${result.session.id}${result.session.title ? ` (${result.session.title})` : ""}`)
  } else if (result.continue) {
    lines.push(`  Session:       none found to continue`)
  }
  if (result.fork !== undefined) {
    lines.push(`  Fork:          ${result.fork ? "yes" : "no"}`)
  }
  if (result.error) {
    lines.push(`  Error:         ${result.error}`)
  }
  lines.push(`  Checked at:    ${result.checkedAt}`)
  return lines
}

export async function writeAttachCheckOutputFile(output: string, result: AttachCheckResult, isJson: boolean) {
  const resolved = path.resolve(output)
  const fs = await import("fs/promises")
  await fs.mkdir(path.dirname(resolved), { recursive: true })
  const content =
    output.endsWith(".json") || isJson
      ? JSON.stringify(result, null, 2) + EOL
      : formatAttachCheckText(result).join(EOL) + EOL
  await fs.writeFile(resolved, content, "utf-8")
  if (!isJson) {
    UI.println(`Wrote attach check results to ${resolved}`)
  }
}

export async function checkAttach(input: {
  url: string
  sessionID?: string
  continueSession?: boolean
  fork?: boolean
  directory?: string
  headers?: RequestInit["headers"]
  fetch?: typeof fetch
}): Promise<AttachCheckResult> {
  const client = createOpencodeClient({
    baseUrl: input.url,
    directory: input.directory,
    fetch: input.fetch,
    headers: input.headers,
  })

  const checkedAt = new Date().toISOString()
  const result: AttachCheckResult = {
    url: input.url,
    healthy: false,
    authenticated: Boolean(input.headers && "Authorization" in input.headers),
    ...(input.directory ? { directory: input.directory } : {}),
    ...(input.fork !== undefined ? { fork: input.fork } : {}),
    ...(input.continueSession !== undefined ? { continue: input.continueSession } : {}),
    checkedAt,
  }

  try {
    const healthRes = await client.global.health({ throwOnError: true })
    result.healthy = true
    if (healthRes.data && typeof healthRes.data === "object" && "version" in healthRes.data) {
      result.version = (healthRes.data as { version?: string }).version
    }
  } catch (err) {
    result.healthy = false
    result.error = errorMessage(err)
    return result
  }

  if (input.sessionID) {
    try {
      const sessionRes = await client.session.get({ sessionID: input.sessionID }, { throwOnError: true })
      const s = sessionRes.data
      if (s) {
        result.session = {
          id: s.id,
          title: s.title,
          parentID: s.parentID,
          created: s.time?.created,
          updated: s.time?.updated,
        }
      }
    } catch (err) {
      result.error = errorMessage(err)
    }
  } else if (input.continueSession) {
    try {
      const listRes = await client.session.list(
        { directory: input.directory, limit: 1 },
        { throwOnError: true },
      )
      const latest = listRes.data?.[0]
      if (latest) {
        result.session = {
          id: latest.id,
          title: latest.title,
          parentID: latest.parentID,
          created: latest.time?.created,
          updated: latest.time?.updated,
        }
      }
    } catch (err) {
      result.error = errorMessage(err)
    }
  }

  return result
}

export const AttachCommand = cmd({
  command: "attach <url>",
  describe: "attach to a running lmplayer server",
  builder: (yargs) =>
    yargs
      .positional("url", {
        type: "string",
        describe: "http://localhost:4096",
        demandOption: true,
      })
      .option("dir", {
        type: "string",
        description: "directory to run in",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("fork", {
        type: "boolean",
        describe: "fork the session when continuing (use with --continue or --session)",
      })
      .option("password", {
        alias: ["p"],
        type: "string",
        describe: "basic auth password (defaults to OPENCODE_SERVER_PASSWORD)",
      })
      .option("username", {
        alias: ["u"],
        type: "string",
        describe: "basic auth username (defaults to OPENCODE_SERVER_USERNAME or 'opencode')",
      })
      .option("mini", {
        type: "boolean",
        describe: "start the minimal interactive interface",
        default: false,
      })
      .option("replay", {
        type: "boolean",
        hidden: true,
      })
      .option("no-replay", {
        type: "boolean",
        describe: "disable mini session history replay on resume and after resize",
      })
      .option("replay-limit", {
        type: "number",
        describe: "cap visible mini replay to the newest N messages",
      })
      .option("check", {
        type: "boolean",
        describe: "validate server connectivity and session without starting interactive interface",
      })
      .option("output", {
        alias: ["o"],
        type: "string",
        describe: "write check result to a file",
      })
      .option("json", {
        type: "boolean",
        describe: "output check result as JSON",
      }),
  handler: async (args) => {
    if (args.replay === true) {
      UI.error("--replay is not supported; replay is enabled by default")
      process.exitCode = 1
      return
    }
    const noReplay = args.replay === false || args.noReplay === true

    const directory = (() => {
      if (!args.dir) return undefined
      try {
        process.chdir(args.dir)
        return process.cwd()
      } catch {
        // If the directory doesn't exist locally (remote attach), pass it through.
        return args.dir
      }
    })()

    const isCheck = Boolean(args.check || args.json || args.output)
    if (isCheck) {
      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exitCode = 1
        return
      }

      const headers = ServerAuth.headers({ password: args.password, username: args.username })
      const result = await checkAttach({
        url: args.url,
        sessionID: args.session,
        continueSession: args.continue,
        fork: args.fork,
        directory,
        headers,
      })

      if (args.output) {
        await writeAttachCheckOutputFile(args.output, result, Boolean(args.json))
      }

      if (args.json) {
        UI.println(JSON.stringify(result, null, 2))
      } else {
        const lines = formatAttachCheckText(result)
        for (const line of lines) {
          UI.println(line)
        }
      }

      if (!result.healthy || result.error) {
        process.exitCode = 1
      }
      return
    }

    if (args.mini) {
      const { runMini } = await import("./run")
      await runMini({
        attach: args.url,
        directory,
        password: args.password,
        username: args.username,
        continue: args.continue,
        session: args.session,
        fork: args.fork,
        replay: noReplay ? false : undefined,
        replayLimit: args.replayLimit,
      })
      return
    }

    const unsupported = [
      ["--no-replay", noReplay],
      ["--replay-limit", args.replayLimit !== undefined],
    ].find((entry) => entry[1])?.[0]
    if (unsupported) {
      UI.error(`${unsupported} requires --mini`)
      process.exitCode = 1
      return
    }

    const { TuiConfig } = await import("@/config/tui")
    if (args.fork && !args.continue && !args.session) {
      UI.error("--fork requires --continue or --session")
      process.exitCode = 1
      return
    }

    const headers = ServerAuth.headers({ password: args.password, username: args.username })
    const config = await TuiConfig.get()

    try {
      await validateSession({
        url: args.url,
        sessionID: args.session,
        directory,
        headers,
      })
    } catch (error) {
      UI.error(errorMessage(error))
      process.exitCode = 1
      return
    }

    const { Effect } = await import("effect")
    const { run } = await import("../tui/layer")
    const { createLegacyTuiPluginHost } = await import("@/plugin/tui/runtime")
    await Effect.runPromise(
      run({
        url: args.url,
        config,
        pluginHost: createLegacyTuiPluginHost(),
        args: {
          continue: args.continue,
          sessionID: args.session,
          fork: args.fork,
        },
        directory,
        headers,
      }),
    )
  },
})
