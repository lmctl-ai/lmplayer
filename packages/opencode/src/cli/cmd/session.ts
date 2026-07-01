import type { Argv } from "yargs"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { Session } from "@/session/session"
import { SessionID } from "../../session/schema"
import { UI } from "../ui"
import { Locale } from "@/util/locale"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"
import { NotFoundError } from "@/storage/storage"
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2"
import { EOL } from "os"
import path from "path"
import { which } from "@opencode-ai/core/util/which"

type SessionMessage = NonNullable<Awaited<ReturnType<OpencodeClient["session"]["messages"]>>["data"]>[number]

function pagerCmd(): string[] {
  const lessOptions = ["-R", "-S"]
  if (process.platform !== "win32") {
    return ["less", ...lessOptions]
  }

  // user could have less installed via other options
  const lessOnPath = which("less")
  if (lessOnPath) {
    if (Filesystem.stat(lessOnPath)?.size) return [lessOnPath, ...lessOptions]
  }

  if (Flag.OPENCODE_GIT_BASH_PATH) {
    const less = path.join(Flag.OPENCODE_GIT_BASH_PATH, "..", "..", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }

  const git = which("git")
  if (git) {
    const less = path.join(git, "..", "..", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }

  // Fall back to Windows built-in more (via cmd.exe)
  return ["cmd", "/c", "more"]
}

export const SessionCommand = cmd({
  command: "session",
  describe: "manage sessions",
  builder: (yargs: Argv) =>
    yargs
      .command(SessionLsCommand)
      .command(SessionTailCommand)
      .command(SessionListCommand)
      .command(SessionDeleteCommand)
      .demandCommand(),
  async handler() {},
})

export const SessionLsCommand = effectCmd({
  command: "ls",
  describe: "list sessions",
  builder: (yargs) =>
    yargs.option("json", {
      describe: "output JSON",
      type: "boolean",
    }),
  handler: Effect.fn("Cli.session.ls")(function* (args) {
    const sdk = yield* localSdk()
    yield* Effect.promise(async () => {
      const response = await sdk.session.list()
      const sessions = (response.data ?? []).toSorted((a, b) => b.time.updated - a.time.updated)
      const rows = await Promise.all(
        sessions.map(async (session) => ({
          session,
          messageCount: (await sdk.session.messages({ sessionID: session.id })).data?.length ?? 0,
        })),
      )

      if (args.json) {
        console.log(
          JSON.stringify(
            rows.map((row) => ({
              id: row.session.id,
              title: row.session.title,
              directory: row.session.directory,
              updated: row.session.time.updated,
              messageCount: row.messageCount,
            })),
            null,
            2,
          ),
        )
        return
      }

      rows.forEach((row) => {
        UI.println(row.session.id, row.session.title, row.session.directory)
      })
    })
  }),
})

export const SessionTailCommand = effectCmd({
  command: "tail <sessionID>",
  describe: "print recent session messages",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        describe: "session ID to inspect",
        type: "string",
        demandOption: true,
      })
      .option("n", {
        describe: "number of messages to print",
        type: "number",
        default: 20,
      })
      .option("json", {
        describe: "output JSON",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.session.tail")(function* (args) {
    const sdk = yield* localSdk()
    yield* Effect.promise(async () => {
      const limit = Number.isInteger(args.n) && args.n >= 0 ? args.n : 20
      const response = await sdk.session.messages({ sessionID: args.sessionID, limit })
      const rows = (response.data ?? []).map((message) => ({
        role: message.info.role,
        text: messageText(message),
        time: message.info.time.created,
      }))

      if (args.json) {
        console.log(JSON.stringify(rows, null, 2))
        return
      }

      rows.forEach((row) => {
        UI.println(`${row.role}: ${row.text}`)
      })
    })
  }),
})

export const SessionDeleteCommand = effectCmd({
  command: "delete <sessionID>",
  describe: "delete a session",
  builder: (yargs) =>
    yargs.positional("sessionID", {
      describe: "session ID to delete",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.session.delete")(function* (args) {
    const svc = yield* Session.Service
    const sessionID = SessionID.make(args.sessionID)
    yield* svc
      .remove(sessionID)
      .pipe(Effect.catchIf(NotFoundError.isInstance, () => fail(`Session not found: ${args.sessionID}`)))
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Session ${args.sessionID} deleted` + UI.Style.TEXT_NORMAL)
  }),
})

export const SessionListCommand = effectCmd({
  command: "list",
  describe: "list sessions",
  builder: (yargs) =>
    yargs
      .option("max-count", {
        alias: "n",
        describe: "limit to N most recent sessions",
        type: "number",
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.session.list")(function* (args) {
    const sessions = yield* Session.Service.use((svc) => svc.list({ roots: true, limit: args.maxCount }))

    if (sessions.length === 0) return

    const output = args.format === "json" ? formatSessionJSON(sessions) : formatSessionTable(sessions)

    const shouldPaginate = process.stdout.isTTY && !args.maxCount && args.format === "table"

    if (shouldPaginate) {
      yield* Effect.promise(async () => {
        const proc = Process.spawn(pagerCmd(), {
          stdin: "pipe",
          stdout: "inherit",
          stderr: "inherit",
        })

        if (!proc.stdin) {
          console.log(output)
          return
        }

        proc.stdin.write(output)
        proc.stdin.end()
        await proc.exited
      })
    } else {
      console.log(output)
    }
  }),
})

function formatSessionTable(sessions: Session.Info[]): string {
  const lines: string[] = []

  const maxIdWidth = Math.max(20, ...sessions.map((s) => s.id.length))
  const maxTitleWidth = Math.max(25, ...sessions.map((s) => s.title.length))

  const header = `Session ID${" ".repeat(maxIdWidth - 10)}  Title${" ".repeat(maxTitleWidth - 5)}  Updated`
  lines.push(header)
  lines.push("─".repeat(header.length))
  for (const session of sessions) {
    const truncatedTitle = Locale.truncate(session.title, maxTitleWidth)
    const timeStr = Locale.todayTimeOrDateTime(session.time.updated)
    const line = `${session.id.padEnd(maxIdWidth)}  ${truncatedTitle.padEnd(maxTitleWidth)}  ${timeStr}`
    lines.push(line)
  }

  return lines.join(EOL)
}

function formatSessionJSON(sessions: Session.Info[]): string {
  const jsonData = sessions.map((session) => ({
    id: session.id,
    title: session.title,
    updated: session.time.updated,
    created: session.time.created,
    projectId: session.projectID,
    directory: session.directory,
  }))
  return JSON.stringify(jsonData, null, 2)
}

const localSdk = Effect.fn("Cli.session.localSdk")(function* () {
  const { ServerAuth } = yield* Effect.promise(() => import("@/server/auth"))
  return createOpencodeClient({
    baseUrl: "http://opencode.internal",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const { Server } = await import("@/server/server")
      const request = new Request(input, init)
      const headers = new Headers(request.headers)
      const auth = ServerAuth.header()
      if (auth) headers.set("Authorization", auth)
      return Server.Default().app.fetch(new Request(request, { headers }))
    }) as typeof globalThis.fetch,
    directory: process.cwd(),
  })
})

function messageText(message: SessionMessage) {
  const text = message.parts
    .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : []))
    .join("")
    .trim()
  if (text) return text

  const tools = message.parts.flatMap((part) => (part.type === "tool" ? [toolMarker(part)] : []))
  if (tools.length > 0) return tools.join(" ")

  return ""
}

function toolMarker(part: Extract<SessionMessage["parts"][number], { type: "tool" }>) {
  if (part.state.status === "completed") return `[tool:${part.tool} completed]`
  if (part.state.status === "error") return `[tool:${part.tool} error]`
  return `[tool:${part.tool} ${part.state.status}]`
}
