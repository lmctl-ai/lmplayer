import { EOL } from "os"
import { Effect } from "effect"
import path from "node:path"
import { Skill } from "../../../skill"
import { effectCmd } from "../../effect-cmd"
import { UI } from "@/cli/ui"

export const SkillCommand = effectCmd({
  command: "skill",
  describe: "list all available skills",
  builder: (yargs) =>
    yargs.option("output", {
      alias: "o",
      type: "string",
      describe: "write skills to output file path",
    }),
  handler: Effect.fn("Cli.debug.skill")(function* (args: { output?: string }) {
    const skill = yield* Skill.Service
    const skills = yield* skill.all()
    const json = JSON.stringify(skills, null, 2) + EOL
    if (args.output) {
      const resolved = path.resolve(args.output)
      yield* Effect.promise(async () => {
        const fs = await import("node:fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        await fs.writeFile(resolved, json, "utf-8")
      })
      UI.println(`Wrote skills to ${resolved}`)
      return
    }
    process.stdout.write(json)
  }),
})
