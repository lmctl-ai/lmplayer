import { EOL } from "os"
import path from "node:path"
import { Effect } from "effect"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { effectCmd } from "../../effect-cmd"
import { cmd } from "../cmd"
import { InstanceRef } from "@/effect/instance-ref"
import { UI } from "@/cli/ui"

export const RipgrepCommand = cmd({
  command: "rg",
  describe: "ripgrep debugging utilities",
  builder: (yargs) => yargs.command(FilesCommand).command(SearchCommand).demandCommand(),
  async handler() {},
})

export const FilesCommand = effectCmd({
  command: "files",
  describe: "list files using ripgrep",
  builder: (yargs) =>
    yargs
      .option("query", {
        alias: "q",
        type: "string",
        description: "Filter files by query",
      })
      .option("glob", {
        alias: "g",
        type: "string",
        description: "Glob pattern to match files",
      })
      .option("limit", {
        alias: "n",
        type: "number",
        description: "Limit number of results",
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write files list to output file path",
      })
      .option("json", {
        type: "boolean",
        describe: "output JSON",
      }),
  handler: Effect.fn("Cli.debug.rg.files")(function* (args: {
    query?: string
    q?: string
    glob?: string
    g?: string
    limit?: number
    n?: number
    output?: string
    o?: string
    json?: boolean
  }) {
    const ctx = yield* InstanceRef
    if (!ctx) return
    const globPattern = args.glob ?? args.g ?? "**/*"
    const limitCount = args.limit ?? args.n ?? 10_000
    const output = args.output ?? args.o
    const isJson = Boolean(args.json)
    const ripgrep = yield* Ripgrep.Service
    const files = yield* ripgrep
      .glob({
        cwd: ctx.directory,
        pattern: globPattern,
        limit: limitCount,
      })
      .pipe(Effect.orDie)
    const paths = files.map((file) => file.path)
    const text = paths.join(EOL) + EOL

    if (output) {
      const resolved = path.resolve(output)
      yield* Effect.promise(async () => {
        const fs = await import("node:fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        if (isJson) {
          await fs.writeFile(resolved, JSON.stringify(paths, null, 2) + EOL, "utf-8")
        } else {
          await fs.writeFile(resolved, text, "utf-8")
        }
      })
      UI.println(`Wrote files list to ${resolved}`)
      return
    }

    if (args.json) {
      process.stdout.write(JSON.stringify(paths, null, 2) + EOL)
      return
    }

    process.stdout.write(text)
  }),
})

export const SearchCommand = effectCmd({
  command: "search <pattern>",
  describe: "search file contents using ripgrep",
  builder: (yargs) =>
    yargs
      .positional("pattern", {
        type: "string",
        demandOption: true,
        description: "Search pattern",
      })
      .option("glob", {
        alias: "g",
        type: "array",
        description: "File glob patterns",
      })
      .option("limit", {
        alias: "n",
        type: "number",
        description: "Limit number of results",
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write search results to output file path",
      })
      .option("json", {
        type: "boolean",
        describe: "output JSON",
        default: false,
      }),
  handler: Effect.fn("Cli.debug.rg.search")(function* (args: {
    pattern: string
    glob?: (string | number)[]
    g?: (string | number)[]
    limit?: number
    n?: number
    output?: string
    o?: string
    json?: boolean
  }) {
    const ctx = yield* InstanceRef
    if (!ctx) return
    const rawGlob = args.glob ?? args.g
    const limitCount = args.limit ?? args.n ?? 10_000
    const output = args.output ?? args.o
    const ripgrep = yield* Ripgrep.Service
    const results = yield* ripgrep
      .grep({
        cwd: ctx.directory,
        pattern: args.pattern,
        include: rawGlob?.[0] !== undefined ? String(rawGlob[0]) : undefined,
        limit: limitCount,
      })
      .pipe(Effect.orDie)
    const json = JSON.stringify(results, null, 2) + EOL

    if (output) {
      const resolved = path.resolve(output)
      yield* Effect.promise(async () => {
        const fs = await import("node:fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        await fs.writeFile(resolved, json, "utf-8")
      })
      UI.println(`Wrote search results to ${resolved}`)
      return
    }

    process.stdout.write(json)
  }),
})
