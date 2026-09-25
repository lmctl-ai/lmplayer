import { EOL } from "os"
import path from "path"
import { cmd } from "../cmd"
import { UI } from "../../ui"

export const StartupCommand = cmd({
  command: "startup",
  describe: "print startup timing",
  builder: (yargs) =>
    yargs
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write startup timing to output file path",
      })
      .option("json", {
        type: "boolean",
        describe: "output JSON",
      }),
  async handler(args: { output?: string; o?: string; json?: boolean }) {
    const output = args.output ?? args.o
    const isJson = Boolean(args.json)
    const duration = performance.now()
    const jsonStr = JSON.stringify({ startup_ms: duration }, null, 2) + EOL
    const textStr = duration.toString() + EOL

    if (output) {
      const resolved = path.resolve(output)
      const fs = await import("node:fs/promises")
      await fs.mkdir(path.dirname(resolved), { recursive: true })
      await fs.writeFile(resolved, isJson ? jsonStr : textStr, "utf-8")
      UI.println(`Wrote startup timing to ${resolved}`)
      return
    }

    if (isJson) {
      process.stdout.write(jsonStr)
      return
    }

    process.stdout.write(textStr)
  },
})
