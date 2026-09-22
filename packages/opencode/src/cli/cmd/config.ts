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
      .command(ConfigPathCommand)
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
    addScopeOptions(yargs)
      .positional("key", {
        describe: "dotted config key (e.g. compaction.auto); omit to print the whole config",
        type: "string",
      })
      .option("output", {
        alias: "o",
        describe: "write output to file path",
        type: "string",
      })
      .option("json", {
        describe: "output JSON",
        type: "boolean",
        default: false,
      }),
  handler: Effect.fn("Cli.config.get")(function* (args: {
    key?: string
    output?: string
    json?: boolean
    project?: boolean
    global?: boolean
    scope?: "project" | "global"
  }) {
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
      const jsonOut = JSON.stringify(config, null, 2)
      if (args.output) {
        const resolved = path.resolve(args.output)
        yield* Effect.promise(async () => {
          const fs = await import("fs/promises")
          await fs.mkdir(path.dirname(resolved), { recursive: true })
          await fs.writeFile(resolved, jsonOut + EOL, "utf-8")
        })
        UI.println(`Wrote config to ${resolved}`)
        return
      }
      process.stdout.write(jsonOut + EOL)
      return
    }

    let value: unknown = config
    for (const segment of splitKey(args.key)) {
      if (value === null || typeof value !== "object" || !(segment in value)) {
        return yield* fail(`key not found: ${args.key}`)
      }
      value = (value as Record<string, unknown>)[segment]
    }

    const out =
      args.json || (value !== null && typeof value === "object") ? JSON.stringify(value, null, 2) : String(value)
    if (args.output) {
      const resolved = path.resolve(args.output)
      yield* Effect.promise(async () => {
        const fs = await import("fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        await fs.writeFile(resolved, out + EOL, "utf-8")
      })
      UI.println(`Wrote config value to ${resolved}`)
      return
    }
    process.stdout.write(out + EOL)
  }),
})

export const ConfigListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list configuration (merged effective, or scoped)",
  builder: (yargs) =>
    addScopeOptions(yargs)
      .option("output", {
        alias: "o",
        describe: "write configuration list to file path",
        type: "string",
      })
      .option("json", {
        describe: "output JSON",
        type: "boolean",
        default: false,
      }),
  handler: Effect.fn("Cli.config.list")(function* (args: {
    output?: string
    json?: boolean
    project?: boolean
    global?: boolean
    scope?: "project" | "global"
  }) {
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

    const jsonOut = JSON.stringify(config, null, 2)
    if (args.output) {
      const resolved = path.resolve(args.output)
      yield* Effect.promise(async () => {
        const fs = await import("fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        await fs.writeFile(resolved, jsonOut + EOL, "utf-8")
      })
      UI.println(`Wrote config list to ${resolved}`)
      return
    }
    process.stdout.write(jsonOut + EOL)
  }),
})

export const ConfigSetCommand = effectCmd({
  command: "set <key> <value>",
  describe: "set a config value (dotted key)",
  builder: (yargs) =>
    addScopeOptions(yargs)
      .positional("key", { describe: "dotted config key (e.g. model)", type: "string", demandOption: true })
      .positional("value", { describe: "value to set", type: "string", demandOption: true })
      .option("json", { describe: "parse <value> as JSON", type: "boolean" })
      .option("output", {
        alias: "o",
        describe: "write set result to output file path",
        type: "string",
      }),
  handler: Effect.fn("Cli.config.set")(function* (args: {
    key: string
    value: string
    json?: boolean
    output?: string
    project?: boolean
    global?: boolean
    scope?: "project" | "global"
  }) {
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

    const textResult = `set ${args.key} = ${JSON.stringify(coerced)}${EOL}`

    if (args.output) {
      const resolved = path.resolve(args.output)
      yield* Effect.promise(async () => {
        const fs = await import("fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        if (args.output?.endsWith(".json")) {
          await fs.writeFile(
            resolved,
            JSON.stringify(
              {
                ok: true,
                key: args.key,
                value: coerced,
                scope: isProject ? "project" : "global",
              },
              null,
              2,
            ) + EOL,
            "utf-8",
          )
        } else {
          await fs.writeFile(resolved, textResult, "utf-8")
        }
      })
      UI.println(`Wrote config set result to ${resolved}`)
    } else {
      process.stdout.write(textResult)
    }

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
    addScopeOptions(yargs)
      .positional("key", {
        describe: "dotted config key to remove",
        type: "string",
        demandOption: true,
      })
      .option("output", {
        alias: "o",
        describe: "write unset result to output file path",
        type: "string",
      })
      .option("json", {
        describe: "output JSON",
        type: "boolean",
        default: false,
      }),
  handler: Effect.fn("Cli.config.unset")(function* (args: {
    key: string
    output?: string
    json?: boolean
    project?: boolean
    global?: boolean
    scope?: "project" | "global"
  }) {
    const { Config } = yield* Effect.promise(() => import("@/config/config"))
    const isProject = args.project || args.scope === "project"
    const segments = splitKey(args.key)

    const result = yield* mapConfigError(
      Config.Service.use((cfg) => (isProject ? cfg.unsetProject(segments) : cfg.unsetGlobal(segments))),
    )

    const textResult = `${result.changed ? "unset" : "unchanged"} ${args.key}${EOL}`
    const jsonResult =
      JSON.stringify(
        {
          ok: true,
          key: args.key,
          changed: result.changed,
          scope: isProject ? "project" : "global",
        },
        null,
        2,
      ) + EOL

    if (args.output) {
      const resolved = path.resolve(args.output)
      yield* Effect.promise(async () => {
        const fs = await import("fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        await fs.writeFile(resolved, args.json ? jsonResult : textResult, "utf-8")
      })
      UI.println(`Wrote config unset result to ${resolved}`)
    } else if (args.json) {
      process.stdout.write(jsonResult)
    } else {
      process.stdout.write(textResult)
    }

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
  builder: (yargs) =>
    yargs
      .option("output", {
        alias: "o",
        describe: "write verify report to output file path",
        type: "string",
      })
      .option("json", {
        describe: "output JSON",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.config.verify")(function* (args: {
    output?: string
    json?: boolean
  }) {
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

    if (args.json) {
      const result = {
        ok: true,
        sources,
        model: config.model ?? null,
        small_model: config.small_model ?? null,
        default_agent: config.default_agent ?? null,
        default_variant: config.default_variant ?? config.variant ?? null,
      }
      const jsonOut = JSON.stringify(result, null, 2)
      if (args.output) {
        const resolved = path.resolve(args.output)
        yield* Effect.promise(async () => {
          const fs = await import("fs/promises")
          await fs.mkdir(path.dirname(resolved), { recursive: true })
          await fs.writeFile(resolved, jsonOut + EOL, "utf-8")
        })
        UI.println(`Wrote verify report to ${resolved}`)
        return
      }
      process.stdout.write(jsonOut + EOL)
      return
    }

    if (args.output) {
      const plainReport = [
        "Config OK",
        ...sources.map((s) => `  ${s}`),
        `  model: ${config.model ?? "(default)"}`,
        `  small_model: ${config.small_model ?? "(default)"}`,
        `  default_agent: ${config.default_agent ?? "(default)"}`,
        `  default_variant: ${config.default_variant ?? config.variant ?? "(default)"}`,
      ].join(EOL) + EOL
      const resolved = path.resolve(args.output)
      yield* Effect.promise(async () => {
        const fs = await import("fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        await fs.writeFile(resolved, plainReport, "utf-8")
      })
      UI.println(`Wrote verify report to ${resolved}`)
      return
    }

    UI.println(UI.Style.TEXT_SUCCESS_BOLD + "Config OK" + UI.Style.TEXT_NORMAL)
    for (const source of sources) process.stdout.write(`  ${source}${EOL}`)
    process.stdout.write(`  model: ${config.model ?? "(default)"}${EOL}`)
    process.stdout.write(`  small_model: ${config.small_model ?? "(default)"}${EOL}`)
    process.stdout.write(`  default_agent: ${config.default_agent ?? "(default)"}${EOL}`)
    process.stdout.write(`  default_variant: ${config.default_variant ?? config.variant ?? "(default)"}${EOL}`)
  }),
})

export const ConfigPathCommand = effectCmd({
  command: "path",
  describe: "print configuration file path",
  builder: (yargs) =>
    addScopeOptions(yargs)
      .option("output", {
        alias: "o",
        describe: "write config path to output file path",
        type: "string",
      })
      .option("json", {
        describe: "output JSON",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.config.path")(function* (args: {
    scope?: "project" | "global"
    project?: boolean
    global?: boolean
    output?: string
    json?: boolean
  }) {
    const { globalConfigFile, projectConfigFile } = yield* Effect.promise(() => import("@/config/config"))
    const isProject = args.project || args.scope === "project"
    const isGlobal = args.global || args.scope === "global"

    const projectFile = projectConfigFile(process.cwd())
    const globalFile = globalConfigFile()

    let textContent = ""
    let jsonContent: unknown = undefined

    if (args.json) {
      const sources = configSources(process.cwd())
      jsonContent = {
        project: projectFile,
        global: globalFile,
        sources,
        selected: isProject ? projectFile : isGlobal ? globalFile : undefined,
      }
    } else if (isProject) {
      textContent = projectFile + EOL
    } else if (isGlobal) {
      textContent = globalFile + EOL
    } else {
      const sources = configSources(process.cwd())
      textContent = sources.join(EOL) + EOL
    }

    if (args.output) {
      const resolved = path.resolve(args.output)
      yield* Effect.promise(async () => {
        const fs = await import("fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        if (args.json) {
          await fs.writeFile(resolved, JSON.stringify(jsonContent, null, 2) + EOL, "utf-8")
        } else {
          await fs.writeFile(resolved, textContent, "utf-8")
        }
      })
      UI.println(`Wrote config path to ${resolved}`)
      return
    }

    if (args.json) {
      process.stdout.write(JSON.stringify(jsonContent, null, 2) + EOL)
      return
    }

    process.stdout.write(textContent)
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
