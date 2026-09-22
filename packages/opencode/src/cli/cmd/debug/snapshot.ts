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

const TrackCommand = effectCmd({
  command: "track",
  describe: "track current snapshot state",
  builder: (yargs) =>
    yargs.option("output", {
      alias: "o",
      type: "string",
      describe: "write track result to output file path",
    }),
  handler: Effect.fn("Cli.debug.snapshot.track")(function* (args: { output?: string }) {
    const out = yield* Snapshot.Service.use((svc) => svc.track())
    if (args.output) {
      const resolved = path.resolve(args.output)
      yield* Effect.promise(async () => {
        const fs = await import("node:fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        await fs.writeFile(resolved, String(out) + os.EOL, "utf-8")
      })
      UI.println(`Wrote snapshot track result to ${resolved}`)
      return
    }
    console.log(out)
  }),
})

const PatchCommand = effectCmd({
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
      }),
  handler: Effect.fn("Cli.debug.snapshot.patch")(function* (args: { hash: string; output?: string }) {
    const out = yield* Snapshot.Service.use((svc) => svc.patch(args.hash))
    if (args.output) {
      const resolved = path.resolve(args.output)
      yield* Effect.promise(async () => {
        const fs = await import("node:fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        await fs.writeFile(resolved, String(out) + os.EOL, "utf-8")
      })
      UI.println(`Wrote patch to ${resolved}`)
      return
    }
    console.log(out)
  }),
})

const DiffCommand = effectCmd({
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
      }),
  handler: Effect.fn("Cli.debug.snapshot.diff")(function* (args: { hash: string; output?: string }) {
    const out = yield* Snapshot.Service.use((svc) => svc.diff(args.hash))
    if (args.output) {
      const resolved = path.resolve(args.output)
      yield* Effect.promise(async () => {
        const fs = await import("node:fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        await fs.writeFile(resolved, String(out) + os.EOL, "utf-8")
      })
      UI.println(`Wrote diff to ${resolved}`)
      return
    }
    console.log(out)
  }),
})
