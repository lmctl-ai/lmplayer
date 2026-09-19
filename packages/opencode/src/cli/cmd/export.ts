import { Session } from "@/session/session"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageV2 } from "../../session/message-v2"
import { SessionID } from "../../session/schema"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { EOL } from "os"
import path from "path"
import fs from "fs/promises"
import { Effect } from "effect"

function redact(kind: string, id: string, value: string) {
  return value.trim() ? `[redacted:${kind}:${id}]` : value
}

function data(kind: string, id: string, value: Record<string, unknown> | undefined) {
  if (!value) return value
  return Object.keys(value).length ? { redacted: `${kind}:${id}` } : value
}

function span(id: string, value: { value: string; start: number; end: number }) {
  return {
    ...value,
    value: redact("file-text", id, value.value),
  }
}

function diff(kind: string, diffs: { file?: string; patch?: string }[] | undefined) {
  return diffs?.map((item, i) => ({
    ...item,
    file: item.file === undefined ? undefined : redact(`${kind}-file`, String(i), item.file),
    patch: item.patch === undefined ? undefined : redact(`${kind}-patch`, String(i), item.patch),
  }))
}

function source(part: SessionV1.FilePart) {
  if (!part.source) return part.source
  if (part.source.type === "symbol") {
    return {
      ...part.source,
      path: redact("file-path", part.id, part.source.path),
      name: redact("file-symbol", part.id, part.source.name),
      text: span(part.id, part.source.text),
    }
  }
  if (part.source.type === "resource") {
    return {
      ...part.source,
      clientName: redact("file-client", part.id, part.source.clientName),
      uri: redact("file-uri", part.id, part.source.uri),
      text: span(part.id, part.source.text),
    }
  }
  return {
    ...part.source,
    path: redact("file-path", part.id, part.source.path),
    text: span(part.id, part.source.text),
  }
}

function filepart(part: SessionV1.FilePart): SessionV1.FilePart {
  return {
    ...part,
    url: redact("file-url", part.id, part.url),
    filename: part.filename === undefined ? undefined : redact("file-name", part.id, part.filename),
    source: source(part),
  }
}

function part(part: SessionV1.Part): SessionV1.Part {
  switch (part.type) {
    case "text":
      return {
        ...part,
        text: redact("text", part.id, part.text),
        metadata: data("text-metadata", part.id, part.metadata),
      }
    case "reasoning":
      return {
        ...part,
        text: redact("reasoning", part.id, part.text),
        metadata: data("reasoning-metadata", part.id, part.metadata),
      }
    case "file":
      return filepart(part)
    case "subtask":
      return {
        ...part,
        prompt: redact("subtask-prompt", part.id, part.prompt),
        description: redact("subtask-description", part.id, part.description),
        command: part.command === undefined ? undefined : redact("subtask-command", part.id, part.command),
      }
    case "tool":
      return {
        ...part,
        metadata: data("tool-metadata", part.id, part.metadata),
        state:
          part.state.status === "pending"
            ? {
                ...part.state,
                input: data("tool-input", part.id, part.state.input) ?? part.state.input,
                raw: redact("tool-raw", part.id, part.state.raw),
              }
            : part.state.status === "running"
              ? {
                  ...part.state,
                  input: data("tool-input", part.id, part.state.input) ?? part.state.input,
                  title: part.state.title === undefined ? undefined : redact("tool-title", part.id, part.state.title),
                  metadata: data("tool-state-metadata", part.id, part.state.metadata),
                }
              : part.state.status === "completed"
                ? {
                    ...part.state,
                    input: data("tool-input", part.id, part.state.input) ?? part.state.input,
                    output: redact("tool-output", part.id, part.state.output),
                    title: redact("tool-title", part.id, part.state.title),
                    metadata: data("tool-state-metadata", part.id, part.state.metadata) ?? part.state.metadata,
                    attachments: part.state.attachments?.map(filepart),
                  }
                : {
                    ...part.state,
                    input: data("tool-input", part.id, part.state.input) ?? part.state.input,
                    metadata: data("tool-state-metadata", part.id, part.state.metadata),
                  },
      }
    case "patch":
      return {
        ...part,
        hash: redact("patch", part.id, part.hash),
        files: part.files.map((item: string, i: number) => redact("patch-file", `${part.id}-${i}`, item)),
      }
    case "snapshot":
      return {
        ...part,
        snapshot: redact("snapshot", part.id, part.snapshot),
      }
    case "step-start":
      return {
        ...part,
        snapshot: part.snapshot === undefined ? undefined : redact("snapshot", part.id, part.snapshot),
      }
    case "step-finish":
      return {
        ...part,
        snapshot: part.snapshot === undefined ? undefined : redact("snapshot", part.id, part.snapshot),
      }
    case "agent":
      return {
        ...part,
        source: !part.source
          ? part.source
          : {
              ...part.source,
              value: redact("agent-source", part.id, part.source.value),
            },
      }
    default:
      return part
  }
}

const partFn = part

function sanitize(data: { info: Session.Info; messages: SessionV1.WithParts[] }) {
  return {
    info: {
      ...data.info,
      title: redact("session-title", data.info.id, data.info.title),
      directory: redact("session-directory", data.info.id, data.info.directory),
      summary: !data.info.summary
        ? data.info.summary
        : {
            ...data.info.summary,
            diffs: diff("session-diff", data.info.summary.diffs),
          },
      revert: !data.info.revert
        ? data.info.revert
        : {
            ...data.info.revert,
            snapshot:
              data.info.revert.snapshot === undefined
                ? undefined
                : redact("revert-snapshot", data.info.id, data.info.revert.snapshot),
            diff:
              data.info.revert.diff === undefined
                ? undefined
                : redact("revert-diff", data.info.id, data.info.revert.diff),
          },
    },
    messages: data.messages.map((msg) => ({
      info:
        msg.info.role === "user"
          ? {
              ...msg.info,
              system: msg.info.system === undefined ? undefined : redact("system", msg.info.id, msg.info.system),
              summary: !msg.info.summary
                ? msg.info.summary
                : {
                    ...msg.info.summary,
                    title:
                      msg.info.summary.title === undefined
                        ? undefined
                        : redact("summary-title", msg.info.id, msg.info.summary.title),
                    body:
                      msg.info.summary.body === undefined
                        ? undefined
                        : redact("summary-body", msg.info.id, msg.info.summary.body),
                    diffs: diff("message-diff", msg.info.summary.diffs),
                  },
            }
          : {
              ...msg.info,
              path: {
                cwd: redact("cwd", msg.info.id, msg.info.path.cwd),
                root: redact("root", msg.info.id, msg.info.path.root),
              },
            },
      parts: msg.parts.map(partFn),
    })),
  }
}

export type ExportArgs = {
  sessionID?: string
  output?: string
  file?: string
  o?: string
  sanitize?: boolean
  json?: boolean
}

export type ExportSummaryJson = {
  ok: boolean
  session_id: string
  file: string
  messages: number
  sanitized: boolean
}

export const ExportCommand = effectCmd({
  command: "export [sessionID]",
  describe: "export session data as JSON",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        describe: "session id to export",
        type: "string",
      })
      .option("output", {
        alias: ["o", "file"],
        describe: "write export JSON to file path",
        type: "string",
      })
      .option("sanitize", {
        describe: "redact sensitive transcript and file data",
        type: "boolean",
      })
      .option("json", {
        describe: "output summary as JSON when exporting to file",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.export")(function* (args: ExportArgs) {
    return yield* runExport(args)
  }),
})

export const runExport = Effect.fn("Cli.export.body")(function* (args: ExportArgs) {
  const svc = yield* Session.Service
  let sessionID = args.sessionID ? SessionID.make(args.sessionID) : undefined
  const targetFile = args.output || args.file || (args as any).o

  if (!sessionID) {
    const sessions = yield* svc.list()

    if (sessions.length === 0) {
      return yield* fail("No sessions found to export")
    }

    sessions.sort((a, b) => b.time.updated - a.time.updated)

    if (process.stdin.isTTY) {
      UI.empty()
      prompts.intro("Export session", { output: process.stderr })

      const selectedSession = yield* Effect.promise(() =>
        prompts.autocomplete({
          message: "Select session to export",
          maxItems: 10,
          options: sessions.map((session) => ({
            label: session.title,
            value: session.id,
            hint: `${new Date(session.time.updated).toLocaleString()} • ${session.id.slice(-8)}`,
          })),
          output: process.stderr,
        }),
      )

      if (prompts.isCancel(selectedSession)) {
        return yield* Effect.die(new UI.CancelledError())
      }

      sessionID = selectedSession
      prompts.outro("Exporting session...", { output: process.stderr })
    } else {
      sessionID = sessions[0].id
    }
  }

  // Match legacy try/catch — catches both typed failures and defects
  // (Session.Service.get throws NotFoundError as a defect, not a typed E).
  return yield* Effect.gen(function* () {
    const sessionInfo = yield* svc.get(sessionID!)
    const messages = yield* svc.messages({ sessionID: sessionInfo.id })

    const rawData = { info: sessionInfo, messages }
    const exportData = args.sanitize ? sanitize(rawData) : rawData
    const jsonStr = JSON.stringify(exportData, null, 2) + EOL

    if (targetFile) {
      const resolved = path.resolve(targetFile)
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        await fs.writeFile(resolved, jsonStr, "utf-8")
      })

      if (args.json) {
        const result: ExportSummaryJson = {
          ok: true,
          session_id: sessionInfo.id,
          file: resolved,
          messages: messages.length,
          sanitized: Boolean(args.sanitize),
        }
        process.stdout.write(JSON.stringify(result, null, 2) + EOL)
        return result
      }

      process.stdout.write(`Exported session ${sessionInfo.id} to ${resolved} (${messages.length} messages)${EOL}`)
      return {
        ok: true,
        session_id: sessionInfo.id,
        file: resolved,
        messages: messages.length,
        sanitized: Boolean(args.sanitize),
      }
    }

    process.stdout.write(jsonStr)
    return exportData
  }).pipe(Effect.catchCause(() => fail(`Session not found: ${sessionID!}`)))
})

const run = runExport
