import { Global } from "@opencode-ai/core/global"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Flag } from "@opencode-ai/core/flag/flag"
import os from "os"
import path from "path"
import { Duration, Effect } from "effect"
import { effectCmd } from "../../effect-cmd"
import { cmd } from "../cmd"
import { UI } from "../../ui"
import { ConfigCommand } from "./config"
import { FileCommand } from "./file"
import { LSPCommand } from "./lsp"
import { RipgrepCommand } from "./ripgrep"
import { ScrapCommand } from "./scrap"
import { SkillCommand } from "./skill"
import { SnapshotCommand } from "./snapshot"
import { AgentCommand } from "./agent"
import { StartupCommand } from "./startup"
import { V2Command } from "./v2"

export const DebugCommand = cmd({
  command: "debug",
  describe: "debugging and troubleshooting tools",
  builder: (yargs) =>
    yargs
      .command(ConfigCommand)
      .command(LSPCommand)
      .command(RipgrepCommand)
      .command(FileCommand)
      .command(ScrapCommand)
      .command(SkillCommand)
      .command(SnapshotCommand)
      .command(StartupCommand)
      .command(AgentCommand)
      .command(V2Command)
      .command(InfoCommand)
      .command(PathsCommand)
      .command(WaitCommand)
      .demandCommand(),
  async handler() {},
})

const WaitCommand = effectCmd({
  command: "wait",
  describe: "wait indefinitely (for debugging)",
  handler: Effect.fn("Cli.debug.wait")(function* () {
    yield* Effect.sleep(Duration.days(1))
  }),
})

const InfoCommand = effectCmd({
  command: "info",
  describe: "show debug information",
  builder: (yargs) =>
    yargs
      .option("json", {
        type: "boolean",
        describe: "output JSON",
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write debug information to output file path",
      }),
  handler: Effect.fn("Cli.debug.info")(function* (args: { json?: boolean; output?: string }) {
    const { Config } = yield* Effect.promise(() => import("@/config/config"))
    const { ConfigPlugin } = yield* Effect.promise(() => import("@/config/plugin"))
    const config = yield* Config.Service.use((cfg) => cfg.get())
    const termProgram = process.env.TERM_PROGRAM
      ? `${process.env.TERM_PROGRAM}${process.env.TERM_PROGRAM_VERSION ? ` ${process.env.TERM_PROGRAM_VERSION}` : ""}`
      : undefined
    const terminal = [termProgram, process.env.TERM].filter((item): item is string => Boolean(item)).join(" / ")

    const plugins = Flag.OPENCODE_PURE
      ? []
      : (config.plugin_origins?.map((plugin) => ConfigPlugin.pluginSpecifier(plugin.spec)) ?? [])

    const info = {
      version: InstallationVersion,
      os: {
        type: os.type(),
        release: os.release(),
        arch: os.arch(),
      },
      terminal: terminal || "unknown",
      pure: Boolean(Flag.OPENCODE_PURE),
      plugins,
    }

    const lines = [
      `opencode version: ${InstallationVersion}`,
      `os: ${os.type()} ${os.release()} ${os.arch()}`,
      `terminal: ${terminal || "unknown"}`,
      "plugins:",
      ...(Flag.OPENCODE_PURE
        ? ["external plugins disabled (--pure)"]
        : plugins.length === 0
          ? ["none"]
          : plugins.map((p) => `- ${p}`)),
    ]
    const text = lines.join(os.EOL)

    if (args.output) {
      const resolved = path.resolve(args.output)
      yield* Effect.promise(async () => {
        const fs = await import("node:fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        if (args.json) {
          await fs.writeFile(resolved, JSON.stringify(info, null, 2) + os.EOL, "utf-8")
        } else {
          await fs.writeFile(resolved, text + os.EOL, "utf-8")
        }
      })
      UI.println(`Wrote debug info to ${resolved}`)
      return
    }

    if (args.json) {
      process.stdout.write(JSON.stringify(info, null, 2) + os.EOL)
      return
    }

    console.log(text)
  }),
})

const PathsCommand = effectCmd({
  command: "paths",
  describe: "show global paths (data, config, cache, state)",
  builder: (yargs) =>
    yargs
      .option("json", {
        type: "boolean",
        describe: "output JSON",
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write global paths to output file path",
      }),
  handler: Effect.fn("Cli.debug.paths")(function* (args: { json?: boolean; output?: string }) {
    const paths = { ...Global.Path }
    const text = Object.entries(paths)
      .map(([key, value]) => `${key.padEnd(10)} ${value}`)
      .join(os.EOL)

    if (args.output) {
      const resolved = path.resolve(args.output)
      yield* Effect.promise(async () => {
        const fs = await import("node:fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        if (args.json) {
          await fs.writeFile(resolved, JSON.stringify(paths, null, 2) + os.EOL, "utf-8")
        } else {
          await fs.writeFile(resolved, text + os.EOL, "utf-8")
        }
      })
      UI.println(`Wrote paths to ${resolved}`)
      return
    }

    if (args.json) {
      process.stdout.write(JSON.stringify(paths, null, 2) + os.EOL)
      return
    }

    console.log(text)
  }),
})
