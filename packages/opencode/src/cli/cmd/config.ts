import type { Argv } from "yargs"
import { EOL } from "os"
import path from "path"
import { Cause, Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { FormatConfigError } from "../error"
import { UI } from "../ui"
import { Global } from "@opencode-ai/core/global"
import { Filesystem } from "@/util/filesystem"

export const ConfigCommand = cmd({
  command: "config",
  describe: "manage configuration",
  builder: (yargs: Argv) => yargs.command(ConfigVerifyCommand).demandCommand(),
  async handler() {},
})

export const ConfigVerifyCommand = effectCmd({
  command: "verify",
  describe: "validate the effective configuration and report errors",
  builder: (yargs) => yargs,
  handler: Effect.fn("Cli.config.verify")(function* () {
    const { Config } = yield* Effect.promise(() => import("@/config/config"))

    // Load the effective config exactly like the app does. JSONC parsing and
    // schema validation sync-throw a ConfigInvalidError/ConfigJsonError (a
    // defect), so catchCause covers both failures and defects; map a recognised
    // config error to the same readable report FormatError prints at launch.
    const config = yield* Config.Service.use((cfg) => cfg.get()).pipe(
      Effect.catchCause((cause) => {
        const squashed = Cause.squash(cause)
        const formatted = FormatConfigError(squashed)
        if (formatted) return fail(formatted)
        return Effect.failCause(cause as Cause.Cause<never>)
      }),
    )

    const sources = configSources()
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + "Config OK" + UI.Style.TEXT_NORMAL)
    for (const source of sources) process.stdout.write(`  ${source}${EOL}`)
    process.stdout.write(`  model: ${config.model ?? "(default)"}${EOL}`)
    process.stdout.write(`  small_model: ${config.small_model ?? "(default)"}${EOL}`)
    process.stdout.write(`  default_agent: ${config.default_agent ?? "(default)"}${EOL}`)
  }),
})

function configSources() {
  const sources: string[] = []
  for (const file of ["opencode.jsonc", "opencode.json", "config.json"]) {
    const candidate = path.join(Global.Path.config, file)
    if (Filesystem.stat(candidate)?.size !== undefined) sources.push(candidate)
  }
  if (process.env.OPENCODE_CONFIG) sources.push(process.env.OPENCODE_CONFIG)
  if (process.env.OPENCODE_CONFIG_CONTENT) sources.push("OPENCODE_CONFIG_CONTENT (env)")
  if (sources.length === 0) sources.push(Global.Path.config)
  return sources
}
