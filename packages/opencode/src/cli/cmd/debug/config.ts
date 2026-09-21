import { EOL } from "os"
import { Effect } from "effect"
import path from "node:path"
import { effectCmd } from "../../effect-cmd"
import { UI } from "@/cli/ui"

export const ConfigCommand = effectCmd({
  command: "config",
  describe: "show resolved configuration",
  builder: (yargs) =>
    yargs.option("output", {
      alias: "o",
      type: "string",
      describe: "write resolved configuration to output file path",
    }),
  handler: Effect.fn("Cli.debug.config")(function* (args: { output?: string }) {
    const { Config } = yield* Effect.promise(() => import("@/config/config"))
    const config = yield* Config.Service.use((cfg) => cfg.get())
    const json = JSON.stringify(config, null, 2) + EOL
    if (args.output) {
      const resolved = path.resolve(args.output)
      yield* Effect.promise(async () => {
        const fs = await import("node:fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        await fs.writeFile(resolved, json, "utf-8")
      })
      UI.println(`Wrote resolved config to ${resolved}`)
      return
    }
    process.stdout.write(json)
  }),
})
