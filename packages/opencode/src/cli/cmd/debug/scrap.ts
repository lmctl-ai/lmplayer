import { EOL } from "os"
import path from "node:path"
import { cmd } from "../cmd"
import { UI } from "@/cli/ui"

export const ScrapCommand = cmd({
  command: "scrap",
  describe: "list all known projects",
  builder: (yargs) =>
    yargs
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write projects list to output file path",
      })
      .option("json", {
        type: "boolean",
        describe: "output JSON",
        default: false,
      }),
  async handler(args: { output?: string; o?: string; json?: boolean }) {
    const output = args.output ?? args.o
    const { Project } = await import("@/project/project")
    const { AppNodeBuilder } = await import("@opencode-ai/core/effect/app-node-builder")
    const { makeRuntime } = await import("@opencode-ai/core/effect/runtime")
    const runtime = makeRuntime(Project.Service, AppNodeBuilder.build(Project.node))
    const list = await runtime.runPromise((project) => project.list())
    const json = JSON.stringify(list, null, 2) + EOL
    if (output) {
      const resolved = path.resolve(output)
      const fs = await import("node:fs/promises")
      await fs.mkdir(path.dirname(resolved), { recursive: true })
      await fs.writeFile(resolved, json, "utf-8")
      UI.println(`Wrote projects list to ${resolved}`)
      return
    }
    process.stdout.write(json)
  },
})
