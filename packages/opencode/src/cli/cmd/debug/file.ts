import { EOL } from "os"
import path from "node:path"
import { Effect } from "effect"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { effectCmd } from "../../effect-cmd"
import { cmd } from "../cmd"
import { UI } from "@/cli/ui"

const filesystem = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) }))),
    Effect.provide(locationServiceMapLayer),
  )

export const FileSearchCommand = effectCmd({
  command: "search <query>",
  describe: "search files by query",
  builder: (yargs) =>
    yargs
      .positional("query", {
        type: "string",
        demandOption: true,
        description: "Search query",
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write search results to output file path",
      })
      .option("json", {
        type: "boolean",
        describe: "output JSON",
      }),
  handler: Effect.fn("Cli.debug.file.search")(function* (args: {
    query: string
    output?: string
    o?: string
    json?: boolean
  }) {
    const output = args.output ?? args.o
    const isJson = Boolean(args.json)
    const results = yield* Effect.orDie(filesystem(FileSystem.Service.use((svc) => svc.find({ query: args.query }))))
    const paths = results.map((item) => item.path)
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
      UI.println(`Wrote search results to ${resolved}`)
      return
    }

    if (isJson) {
      process.stdout.write(JSON.stringify(paths, null, 2) + EOL)
      return
    }

    process.stdout.write(text)
  }),
})

export const FileReadCommand = effectCmd({
  command: "read <path>",
  describe: "read file contents as JSON",
  builder: (yargs) =>
    yargs
      .positional("path", {
        type: "string",
        demandOption: true,
        description: "File path to read",
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write file contents to output file path",
      })
      .option("json", {
        type: "boolean",
        describe: "output JSON",
        default: false,
      }),
  handler: Effect.fn("Cli.debug.file.read")(function* (args: {
    path: string
    output?: string
    o?: string
    json?: boolean
  }) {
    const output = args.output ?? args.o
    const file = yield* filesystem(FileSystem.Service.use((svc) => svc.read({ path: RelativePath.make(args.path) })))
    const payload = { content: Buffer.from(file.content).toString("base64"), encoding: "base64", mime: file.mime }
    const json = JSON.stringify(payload, null, 2) + EOL

    if (output) {
      const resolved = path.resolve(output)
      yield* Effect.promise(async () => {
        const fs = await import("node:fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        await fs.writeFile(resolved, json, "utf-8")
      })
      UI.println(`Wrote file contents to ${resolved}`)
      return
    }

    process.stdout.write(json)
  }),
})

export const FileListCommand = effectCmd({
  command: "list <path>",
  describe: "list files in a directory",
  builder: (yargs) =>
    yargs
      .positional("path", {
        type: "string",
        demandOption: true,
        description: "File path to list",
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write file list to output file path",
      })
      .option("json", {
        type: "boolean",
        describe: "output JSON",
        default: false,
      }),
  handler: Effect.fn("Cli.debug.file.list")(function* (args: {
    path: string
    output?: string
    o?: string
    json?: boolean
  }) {
    const output = args.output ?? args.o
    const files = yield* filesystem(FileSystem.Service.use((svc) => svc.list({ path: RelativePath.make(args.path) })))
    const json = JSON.stringify(files, null, 2) + EOL

    if (output) {
      const resolved = path.resolve(output)
      yield* Effect.promise(async () => {
        const fs = await import("node:fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        await fs.writeFile(resolved, json, "utf-8")
      })
      UI.println(`Wrote file list to ${resolved}`)
      return
    }

    process.stdout.write(json)
  }),
})

export const FileCommand = cmd({
  command: "file",
  describe: "file system debugging utilities",
  builder: (yargs) =>
    yargs.command(FileReadCommand).command(FileListCommand).command(FileSearchCommand).demandCommand(),
  async handler() {},
})
