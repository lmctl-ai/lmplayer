import { LSP } from "@/lsp/lsp"
import { Effect } from "effect"
import path from "node:path"
import { effectCmd } from "../../effect-cmd"
import { cmd } from "../cmd"
import { EOL } from "os"
import { UI } from "@/cli/ui"

export const LSPCommand = cmd({
  command: "lsp",
  describe: "LSP debugging utilities",
  builder: (yargs) =>
    yargs.command(DiagnosticsCommand).command(SymbolsCommand).command(DocumentSymbolsCommand).demandCommand(),
  async handler() {},
})

const DiagnosticsCommand = effectCmd({
  command: "diagnostics <file>",
  describe: "get diagnostics for a file",
  builder: (yargs) =>
    yargs
      .positional("file", { type: "string", demandOption: true })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write diagnostics to output file path",
      }),
  handler: Effect.fn("Cli.debug.lsp.diagnostics")(function* (args: { file: string; output?: string }) {
    const out = yield* LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        yield* lsp.touchFile(args.file, "full")
        return yield* lsp.diagnostics()
      }),
    )
    const json = JSON.stringify(out, null, 2) + EOL
    if (args.output) {
      const resolved = path.resolve(args.output)
      yield* Effect.promise(async () => {
        const fs = await import("node:fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        await fs.writeFile(resolved, json, "utf-8")
      })
      UI.println(`Wrote diagnostics to ${resolved}`)
      return
    }
    process.stdout.write(json)
  }),
})

const SymbolsCommand = effectCmd({
  command: "symbols <query>",
  describe: "search workspace symbols",
  builder: (yargs) =>
    yargs
      .positional("query", { type: "string", demandOption: true })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write symbols to output file path",
      }),
  handler: Effect.fn("Cli.debug.lsp.symbols")(function* (args: { query: string; output?: string }) {
    yield* Effect.logInfo("symbols")
    const results = yield* LSP.Service.use((lsp) => lsp.workspaceSymbol(args.query))
    const json = JSON.stringify(results, null, 2) + EOL
    if (args.output) {
      const resolved = path.resolve(args.output)
      yield* Effect.promise(async () => {
        const fs = await import("node:fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        await fs.writeFile(resolved, json, "utf-8")
      })
      UI.println(`Wrote symbols to ${resolved}`)
      return
    }
    process.stdout.write(json)
  }),
})

const DocumentSymbolsCommand = effectCmd({
  command: "document-symbols <uri>",
  describe: "get symbols from a document",
  builder: (yargs) =>
    yargs
      .positional("uri", { type: "string", demandOption: true })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write document symbols to output file path",
      }),
  handler: Effect.fn("Cli.debug.lsp.documentSymbols")(function* (args: { uri: string; output?: string }) {
    yield* Effect.logInfo("document-symbols")
    const results = yield* LSP.Service.use((lsp) => lsp.documentSymbol(args.uri))
    const json = JSON.stringify(results, null, 2) + EOL
    if (args.output) {
      const resolved = path.resolve(args.output)
      yield* Effect.promise(async () => {
        const fs = await import("node:fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        await fs.writeFile(resolved, json, "utf-8")
      })
      UI.println(`Wrote document symbols to ${resolved}`)
      return
    }
    process.stdout.write(json)
  }),
})
