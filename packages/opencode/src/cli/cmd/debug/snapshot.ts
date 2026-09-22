import { Effect } from "effect"
import path from "node:path"
import os from "node:os"
import { Snapshot } from "../../../snapshot"
import { effectCmd } from "../../effect-cmd"
import { cmd } from "../cmd"
import { UI } from "@/cli/ui"

export const SnapshotCommand = cmd({
  command: "snapshot",
  describe: "snapshot debugging utilities",
  builder: (yargs) => yargs.command(TrackCommand).command(PatchCommand).command(DiffCommand).demandCommand(),
  async handler() {},
})

export const TrackCommand = effectCmd({
  command: "track",
  describe: "track current snapshot state",
  builder: (yargs) =>
    yargs
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write track result to output file path",
      })
      .option("json", {
        type: "boolean",
        describe: "output JSON",
        default: false,
      }),
  handler: Effect.fn("Cli.debug.snapshot.track")(function* (args: { output?: string; json?: boolean }) {
    const out = yield* Snapshot.Service.use((svc) => svc.track())
    const jsonStr = JSON.stringify({ hash: out ?? null }, null, 2) + os.EOL
    if (args.output) {
      const resolved = path.resolve(args.output)
      yield* Effect.promise(async () => {
        const fs = await import("node:fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        if (args.json) {
          await fs.writeFile(resolved, jsonStr, "utf-8")
        } else {
          await fs.writeFile(resolved, String(out ?? "") + os.EOL, "utf-8")
        }
      })
      UI.println(`Wrote snapshot track result to ${resolved}`)
      return
    }
    if (args.json) {
      process.stdout.write(jsonStr)
      return
    }
    console.log(out)
  }),
})

export const PatchCommand = effectCmd({
  command: "patch <hash>",
  describe: "show patch for a snapshot hash",
  builder: (yargs) =>
    yargs
      .positional("hash", {
        type: "string",
        description: "hash",
        demandOption: true,
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write patch to output file path",
      })
      .option("json", {
        type: "boolean",
        describe: "output JSON",
        default: false,
      }),
  handler: Effect.fn("Cli.debug.snapshot.patch")(function* (args: { hash: string; output?: string; json?: boolean }) {
    const out = yield* Snapshot.Service.use((svc) => svc.patch(args.hash))
    const jsonStr = JSON.stringify(out, null, 2) + os.EOL
    if (args.output) {
      const resolved = path.resolve(args.output)
      yield* Effect.promise(async () => {
        const fs = await import("node:fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        await fs.writeFile(resolved, jsonStr, "utf-8")
      })
      UI.println(`Wrote patch to ${resolved}`)
      return
    }
    if (args.json) {
      process.stdout.write(jsonStr)
      return
    }
    console.log(out)
  }),
})

export const DiffCommand = effectCmd({
  command: "diff <hash>",
  describe: "show diff for a snapshot hash",
  builder: (yargs) =>
    yargs
      .positional("hash", {
        type: "string",
        description: "hash",
        demandOption: true,
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write diff to output file path",
      })
      .option("json", {
        type: "boolean",
        describe: "output JSON",
        default: false,
      }),
  handler: Effect.fn("Cli.debug.snapshot.diff")(function* (args: { hash: string; output?: string; json?: boolean }) {
    const out = yield* Snapshot.Service.use((svc) => svc.diff(args.hash))
    const jsonStr = JSON.stringify({ hash: args.hash, diff: out }, null, 2) + os.EOL
    if (args.output) {
      const resolved = path.resolve(args.output)
      yield* Effect.promise(async () => {
        const fs = await import("node:fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        if (args.json) {
          await fs.writeFile(resolved, jsonStr, "utf-8")
        } else {
          await fs.writeFile(resolved, String(out) + os.EOL, "utf-8")
        }
      })
      UI.println(`Wrote diff to ${resolved}`)
      return
    }
    if (args.json) {
      process.stdout.write(jsonStr)
      return
    }
    console.log(out)
  }),
})
