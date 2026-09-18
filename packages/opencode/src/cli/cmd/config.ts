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
      .command(ConfigListCommand)
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

const addScopeOptions = (yargs: Argv) =>
  yargs
    .option("scope", {
      describe: "configuration target scope (project or global)",
      choices: ["project", "global"] as const,
      type: "string",
    })
    .option("project", {
      alias: "p",
      describe: "target project configuration",
      type: "boolean",
    })
    .option("global", {
      alias: "g",
      describe: "target global configuration",
      type: "boolean",
    })
    .check((argv) => {
      if (argv.project && argv.global) {
        throw new Error("Cannot specify both --project and --global")
      }
      if (argv.scope && (argv.project || argv.global)) {
        throw new Error("Cannot specify both --scope and --project/--global")
      }
      return true
    })

export const ConfigGetCommand = effectCmd({
  command: "get [key]",
  describe: "read config value(s), optionally a single dotted key",
  builder: (yargs) =>
    addScopeOptions(yargs).positional("key", {
      describe: "dotted config key (e.g. compaction.auto); omit to print the whole config",
      type: "string",
    }),
  handler: Effect.fn("Cli.config.get")(function* (args) {
    const { Config } = yield* Effect.promise(() => import("@/config/config"))
    const isProject = args.project || args.scope === "project"
    const isGlobal = args.global || args.scope === "global"

    const config = yield* mapConfigError(
      Config.Service.use((cfg) => {
        if (isProject) return cfg.getProject()
        if (isGlobal) return cfg.getGlobal()
        return cfg.get()
      }),
    )

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

export const ConfigListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list configuration (merged effective, or scoped)",
  builder: (yargs) => addScopeOptions(yargs),
  handler: Effect.fn("Cli.config.list")(function* (args) {
    const { Config } = yield* Effect.promise(() => import("@/config/config"))
    const isProject = args.project || args.scope === "project"
    const isGlobal = args.global || args.scope === "global"

    const config = yield* mapConfigError(
      Config.Service.use((cfg) => {
        if (isProject) return cfg.getProject()
        if (isGlobal) return cfg.getGlobal()
        return cfg.get()
      }),
    )

    process.stdout.write(JSON.stringify(config, null, 2) + EOL)
  }),
})

export const ConfigSetCommand = effectCmd({
  command: "set <key> <value>",
  describe: "set a config value (dotted key)",
  builder: (yargs) =>
    addScopeOptions(yargs)
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

    const isProject = args.project || args.scope === "project"

    // Build a nested partial Info from the dotted path (model -> {model}, ...).
    const segments = splitKey(args.key)
    const partial = segments.reduceRight<unknown>((acc, segment) => ({ [segment]: acc }), coerced)

    if (isProject) {
      yield* mapConfigError(Config.Service.use((cfg) => cfg.updateProject(partial as never)))
    } else {
      yield* mapConfigError(Config.Service.use((cfg) => cfg.updateGlobal(partial as never)))
    }
    process.stdout.write(`set ${args.key} = ${JSON.stringify(coerced)}${EOL}`)

    // Check if effective config is shadowed by higher precedence configuration
    const effective = yield* mapConfigError(Config.Service.use((cfg) => cfg.get()))
    let effectiveValue: unknown = effective
    let found = true
    for (const segment of segments) {
      if (effectiveValue === null || typeof effectiveValue !== "object" || !(segment in effectiveValue)) {
        found = false
        break
      }
      effectiveValue = (effectiveValue as Record<string, unknown>)[segment]
    }
    if (!found || JSON.stringify(effectiveValue) !== JSON.stringify(coerced)) {
      UI.println(
        UI.Style.TEXT_WARNING +
          `! Warning: ${args.key} is shadowed by higher-precedence configuration (effective: ${JSON.stringify(effectiveValue)})` +
          UI.Style.TEXT_NORMAL,
      )
    }
  }),
})

export const ConfigUnsetCommand = effectCmd({
  command: "unset <key>",
  describe: "remove a config value (dotted key)",
  builder: (yargs) =>
    addScopeOptions(yargs).positional("key", {
      describe: "dotted config key to remove",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.config.unset")(function* (args) {
    const { Config } = yield* Effect.promise(() => import("@/config/config"))
    const isProject = args.project || args.scope === "project"
    const segments = splitKey(args.key)

    const result = yield* mapConfigError(
      Config.Service.use((cfg) => (isProject ? cfg.unsetProject(segments) : cfg.unsetGlobal(segments))),
    )
    process.stdout.write(`${result.changed ? "unset" : "unchanged"} ${args.key}${EOL}`)

    if (result.changed && !isProject) {
      const effective = yield* mapConfigError(Config.Service.use((cfg) => cfg.get()))
      let effectiveValue: unknown = effective
      let found = true
      for (const segment of segments) {
        if (effectiveValue === null || typeof effectiveValue !== "object" || !(segment in effectiveValue)) {
          found = false
          break
        }
        effectiveValue = (effectiveValue as Record<string, unknown>)[segment]
      }
      if (found && effectiveValue !== undefined) {
        UI.println(
          UI.Style.TEXT_WARNING +
            `! Notice: ${args.key} is still set in higher-precedence configuration (effective: ${JSON.stringify(effectiveValue)})` +
            UI.Style.TEXT_NORMAL,
        )
      }
    }
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

    const sources = configSources(process.cwd())
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + "Config OK" + UI.Style.TEXT_NORMAL)
    for (const source of sources) process.stdout.write(`  ${source}${EOL}`)
    process.stdout.write(`  model: ${config.model ?? "(default)"}${EOL}`)
    process.stdout.write(`  small_model: ${config.small_model ?? "(default)"}${EOL}`)
    process.stdout.write(`  default_agent: ${config.default_agent ?? "(default)"}${EOL}`)
  }),
})

function configSources(projectDir?: string) {
  const sources: string[] = []
  for (const file of ["opencode.jsonc", "opencode.json", "config.json"]) {
    const candidate = path.join(Global.Path.config, file)
    if (Filesystem.stat(candidate)?.size !== undefined) sources.push(candidate)
  }
  if (projectDir && projectDir !== Global.Path.config) {
    const projectCandidates = [
      path.join(projectDir, "opencode.jsonc"),
      path.join(projectDir, "opencode.json"),
      path.join(projectDir, ".opencode", "opencode.jsonc"),
      path.join(projectDir, ".opencode", "opencode.json"),
      path.join(projectDir, "config.json"),
    ]
    for (const candidate of projectCandidates) {
      if (Filesystem.stat(candidate)?.size !== undefined) sources.push(candidate)
    }
  }
  if (process.env.OPENCODE_CONFIG) sources.push(process.env.OPENCODE_CONFIG)
  if (process.env.OPENCODE_CONFIG_CONTENT) sources.push("OPENCODE_CONFIG_CONTENT (env)")
  if (sources.length === 0) sources.push(Global.Path.config)
  return Array.from(new Set(sources))
}
