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
  builder: (yargs: Argv) =>
    yargs
      .command(ConfigVerifyCommand)
      .command(ConfigGetCommand)
      .command(ConfigSetCommand)
      .command(ConfigUnsetCommand)
      .demandCommand(),
  async handler() {},
})

// Dotted keys are split on "." (e.g. `compaction.auto`). Keys that themselves
// contain dots (some MCP server names) are a known limitation; use `--json` with
// `config set` to write a whole subtree as a workaround.
const splitKey = (key: string) => key.split(".")

// Map a recognised config schema error (ConfigInvalidError/ConfigJsonError,
// raised as a defect by jsonc parsing + schema validation) to the readable
// FormatConfigError report; otherwise re-raise unchanged.
const mapConfigError = <A, R>(effect: Effect.Effect<A, never, R>) =>
  effect.pipe(
    Effect.catchCause((cause) => {
      const formatted = FormatConfigError(Cause.squash(cause))
      if (formatted) return fail(formatted)
      return Effect.failCause(cause as Cause.Cause<never>)
    }),
  )

export const ConfigGetCommand = effectCmd({
  command: "get [key]",
  describe: "read the effective config, optionally a single dotted key",
  builder: (yargs) =>
    yargs.positional("key", {
      describe: "dotted config key (e.g. compaction.auto); omit to print the whole config",
      type: "string",
    }),
  handler: Effect.fn("Cli.config.get")(function* (args) {
    const { Config } = yield* Effect.promise(() => import("@/config/config"))
    const config = yield* mapConfigError(Config.Service.use((cfg) => cfg.get()))

    if (!args.key) {
      process.stdout.write(JSON.stringify(config, null, 2) + EOL)
      return
    }

    let value: unknown = config
    for (const segment of splitKey(args.key)) {
      if (value === null || typeof value !== "object" || !(segment in value)) {
        return yield* fail(`key not found: ${args.key}`)
      }
      value = (value as Record<string, unknown>)[segment]
    }

    const out = value !== null && typeof value === "object" ? JSON.stringify(value, null, 2) : String(value)
    process.stdout.write(out + EOL)
  }),
})

export const ConfigSetCommand = effectCmd({
  command: "set <key> <value>",
  describe: "set a global config value (dotted key)",
  builder: (yargs) =>
    yargs
      .positional("key", { describe: "dotted config key (e.g. model)", type: "string", demandOption: true })
      .positional("value", { describe: "value to set", type: "string", demandOption: true })
      .option("json", { describe: "parse <value> as JSON", type: "boolean" }),
  handler: Effect.fn("Cli.config.set")(function* (args) {
    const { Config } = yield* Effect.promise(() => import("@/config/config"))

    // --json parsing can throw a raw SyntaxError; surface it as a readable CLI
    // error + non-zero exit instead of letting it escape to the top-level handler.
    let coerced: unknown
    if (args.json) {
      try {
        coerced = JSON.parse(args.value)
      } catch (e) {
        return yield* fail(`invalid --json value: ${e instanceof Error ? e.message : String(e)}`)
      }
    } else {
      coerced = coerceValue(args.value)
    }

    // Build a nested partial Info from the dotted path (model -> {model}, ...).
    const segments = splitKey(args.key)
    const partial = segments.reduceRight<unknown>((acc, segment) => ({ [segment]: acc }), coerced)

    yield* mapConfigError(Config.Service.use((cfg) => cfg.updateGlobal(partial as never)))
    process.stdout.write(`set ${args.key} = ${JSON.stringify(coerced)}${EOL}`)
  }),
})

export const ConfigUnsetCommand = effectCmd({
  command: "unset <key>",
  describe: "remove a global config value (dotted key)",
  builder: (yargs) =>
    yargs.positional("key", { describe: "dotted config key to remove", type: "string", demandOption: true }),
  handler: Effect.fn("Cli.config.unset")(function* (args) {
    const { Config } = yield* Effect.promise(() => import("@/config/config"))
    const result = yield* mapConfigError(Config.Service.use((cfg) => cfg.unsetGlobal(splitKey(args.key))))
    process.stdout.write(`${result.changed ? "unset" : "unchanged"} ${args.key}${EOL}`)
  }),
})

function coerceValue(value: string): unknown {
  if (value === "true") return true
  if (value === "false") return false
  if (/^-?\d+$/.test(value)) return Number(value)
  if (/^-?\d+\.\d+$/.test(value)) return Number(value)
  if (value.startsWith("{") || value.startsWith("[") || value.startsWith('"')) {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  return value
}

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
