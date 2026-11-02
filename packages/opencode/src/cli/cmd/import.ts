import type { Session as SDKSession, Message, Part } from "@opencode-ai/sdk/v2"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session } from "@/session/session"
import { MessageV2 } from "../../session/message-v2"
import { SessionSummary } from "@/session/summary"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable, MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import { InstanceRef } from "@/effect/instance-ref"
import { EOL } from "os"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Schema } from "effect"
import type { InstanceContext } from "@/project/instance-context"

const decodeMessageInfo = Schema.decodeUnknownSync(SessionV1.Info)
const decodePart = Schema.decodeUnknownSync(SessionV1.Part)

export function formatImportFileError(file: string, error: FSUtil.Error) {
  if (error._tag === "PlatformError") {
    if (error.reason._tag === "NotFound") return `File not found: ${file}`
    if (error.reason._tag === "PermissionDenied") return `Failed to read file: Permission denied`
    return `Failed to read file: ${error.message}`
  }

  const detail = error.cause instanceof Error ? error.cause.message : error.message
  return `Invalid JSON in ${file}: ${detail}`
}

type ExportData = { info: SDKSession; messages: Array<{ info: Message; parts: Part[] }> }

export type ImportArgs = {
  file: string
  title?: string
  t?: string
  json?: boolean
  output?: string
  o?: string
}

export type ImportResultJson = {
  ok: boolean
  id: string
  title: string
  messages: number
  parts: number
  file: string
}

export const ImportCommand = effectCmd({
  command: "import <file>",
  describe: "import session data from JSON file",
  builder: (yargs) =>
    yargs
      .positional("file", {
        describe: "path to JSON file or share URL",
        type: "string",
        demandOption: true,
      })
      .option("title", {
        alias: "t",
        describe: "override title of imported session",
        type: "string",
      })
      .option("output", {
        alias: "o",
        describe: "write import result to output file path",
        type: "string",
      })
      .option("json", {
        describe: "output as JSON",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.import")(function* (args: ImportArgs) {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* Effect.die("InstanceRef not provided")
    return yield* runImport(args, ctx)
  }),
})

export const runImport = Effect.fn("Cli.import.body")(function* (
  args: ImportArgs | string,
  ctx: InstanceContext,
) {
  const file = typeof args === "string" ? args : args.file
  const options: Partial<ImportArgs> = typeof args === "string" ? {} : args
  const title = options.title ?? options.t
  const output = options.output ?? options.o
  const isJson = Boolean(options.json)
  const share = yield* ShareNext.Service
  const fs = yield* FSUtil.Service
  const { db } = yield* Database.Service

  if (file.startsWith("http://") || file.startsWith("https://"))
    return yield* fail("Importing from share URLs is no longer supported: session sharing has been discontinued")

  const isUrl = file.startsWith("http://") || file.startsWith("https://")

  if (isUrl) {
    const slug = parseShareUrl(file)
    if (!slug) {
      const baseUrl = yield* Effect.orDie(share.url())
      return yield* fail(`Invalid URL format. Expected: ${baseUrl}/share/<slug>`)
    }

    const baseUrl = new URL(file).origin
    const req = yield* Effect.orDie(share.request())
    const headers = shouldAttachShareAuthHeaders(file, req.baseUrl) ? req.headers : {}

    const tryFetch = (url: string) =>
      Effect.tryPromise({
        try: () => fetch(url, { headers }),
        catch: (e) =>
          new CliError({
            message: `Failed to fetch share data: ${e instanceof Error ? e.message : String(e)}`,
          }),
      })

    const dataPath = req.api.data(slug)
    let response = yield* tryFetch(`${baseUrl}${dataPath}`)

    if (!response.ok && dataPath !== `/api/share/${slug}/data`) {
      response = yield* tryFetch(`${baseUrl}/api/share/${slug}/data`)
    }

    if (!response.ok) {
      return yield* fail(`Failed to fetch share data: ${response.statusText} (${response.status})`)
    }

    const shareData = yield* Effect.tryPromise({
      try: () => response.json() as Promise<ShareData[]>,
      catch: () => new CliError({ message: "Share data was not valid JSON" }),
    })
    const transformed = transformShareData(shareData)

    if (!transformed) {
      return yield* fail(`Share not found or empty: ${slug}`)
    }

    exportData = transformed
  } else {
    exportData = (yield* fs
      .readJson(file)
      .pipe(Effect.mapError((error) => new CliError({ message: formatImportFileError(file, error) })))) as ExportData
  }

  if (!exportData || !exportData.info) {
    return yield* fail(`Failed to read session data from ${file}`)
  }

  if (title) {
    exportData.info.title = title
  }

  const info = Schema.decodeUnknownSync(Session.Info)({
    ...exportData.info,
    projectID: ctx.project.id,
    directory: ctx.directory,
    path: path.relative(path.resolve(ctx.worktree), ctx.directory).replaceAll("\\", "/"),
  }) as Session.Info
  // An imported file's session-level diffs are arbitrary (and may predate the
  // cap SessionSummary.summarize now enforces), so apply the same cap here
  // instead of trusting its size.
  const importedDiffs = info.summary?.diffs ?? []
  const row = Session.toRow({
    ...info,
    summary: info.summary && {
      ...info.summary,
      diffs: SessionSummary.diffBytes(importedDiffs) > SessionSummary.SUMMARY_DIFFS_MAX_BYTES ? [] : importedDiffs,
    },
  })
  yield* db
    .insert(SessionTable)
    .values(row)
    .onConflictDoUpdate({
      target: SessionTable.id,
      set: { project_id: row.project_id, directory: row.directory, path: row.path, title: row.title },
    })
    .run()
    .pipe(Effect.orDie)

  let partCount = 0
  for (const msg of exportData.messages ?? []) {
    const msgInfo = decodeMessageInfo(msg.info) as SessionV1.Info
    const { id, sessionID: _, ...msgData } = msgInfo
    yield* db
      .insert(MessageTable)
      .values({
        id,
        session_id: row.id,
        time_created: msgInfo.time?.created ?? Date.now(),
        data: msgData as never,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)

    for (const part of msg.parts ?? []) {
      partCount++
      const partInfo = decodePart(part) as SessionV1.Part
      const { id: partId, sessionID: _s, messageID, ...partData } = partInfo
      yield* db
        .insert(PartTable)
        .values({
          id: partId,
          message_id: messageID,
          session_id: row.id,
          data: partData,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    }
  }

  const summaryPayload: ImportResultJson = {
    ok: true,
    id: row.id,
    title: row.title,
    messages: exportData.messages?.length ?? 0,
    parts: partCount,
    file,
  }
  const summaryText = `Imported session: ${row.id}`

  if (output) {
    const resolved = path.resolve(output)
    yield* Effect.promise(async () => {
      const fs = await import("fs/promises")
      await fs.mkdir(path.dirname(resolved), { recursive: true })
      if (isJson) {
        await fs.writeFile(resolved, JSON.stringify(summaryPayload, null, 2) + EOL, "utf-8")
      } else {
        await fs.writeFile(resolved, summaryText + EOL, "utf-8")
      }
    })
    process.stdout.write(`Wrote import result to ${resolved}${EOL}`)
    return summaryPayload
  }

  if (isJson) {
    process.stdout.write(JSON.stringify(summaryPayload, null, 2) + EOL)
    return summaryPayload
  }

  process.stdout.write(summaryText + EOL)
  return { ok: true, id: row.id }
})
