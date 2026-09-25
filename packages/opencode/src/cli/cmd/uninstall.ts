import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { Installation } from "../../installation"
import { Global } from "@opencode-ai/core/global"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { EOL } from "os"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"

async function writeOutputFile(filePath: string, content: string, label: string) {
  const resolved = path.resolve(filePath)
  await fs.mkdir(path.dirname(resolved), { recursive: true })
  await fs.writeFile(resolved, content, "utf-8")
  UI.println(`Wrote ${label} to ${resolved}`)
}

export interface UninstallArgs {
  keepConfig?: boolean
  c?: boolean
  keepData?: boolean
  d?: boolean
  dryRun?: boolean
  force?: boolean
  f?: boolean
  output?: string
  o?: string
  json?: boolean
}

export interface RemovalTargets {
  directories: Array<{ path: string; label: string; keep: boolean }>
  shellConfig: string | null
  binary: string | null
}

export interface RemovalDirectoryInfo {
  path: string
  label: string
  keep: boolean
  exists: boolean
  size: number
  sizeFormatted: string
}

export interface UninstallSummary {
  method: Installation.Method
  dryRun: boolean
  directories: RemovalDirectoryInfo[]
  binary: string | null
  shellConfig: string | null
  packageCommand: string | null
}

export async function buildUninstallSummary(
  args: { keepConfig?: boolean; keepData?: boolean; dryRun?: boolean },
  method: Installation.Method,
  targets: RemovalTargets,
): Promise<UninstallSummary> {
  const directories: RemovalDirectoryInfo[] = []
  for (const dir of targets.directories) {
    const exists = await fs
      .access(dir.path)
      .then(() => true)
      .catch(() => false)
    const size = exists ? await getDirectorySize(dir.path) : 0
    directories.push({
      path: dir.path,
      label: dir.label,
      keep: dir.keep,
      exists,
      size,
      sizeFormatted: formatSize(size),
    })
  }

  const packageCommands: Record<string, string> = {
    npm: "npm uninstall -g opencode-ai",
    pnpm: "pnpm uninstall -g opencode-ai",
    bun: "bun remove -g opencode-ai",
    yarn: "yarn global remove opencode-ai",
    brew: "brew uninstall opencode",
    choco: "choco uninstall opencode",
    scoop: "scoop uninstall opencode",
  }

  return {
    method,
    dryRun: Boolean(args.dryRun),
    directories,
    binary: targets.binary,
    shellConfig: targets.shellConfig,
    packageCommand: packageCommands[method] ?? null,
  }
}

export function formatUninstallSummaryText(summary: UninstallSummary): string[] {
  const lines: string[] = []
  lines.push(`Installation method: ${summary.method}`)
  lines.push("Removal targets:")
  for (const dir of summary.directories) {
    if (!dir.exists) continue
    const keepLabel = dir.keep ? " (keeping)" : ""
    const mark = dir.keep ? "○" : "✓"
    lines.push(`  ${mark} ${dir.label}: ${dir.path} (${dir.sizeFormatted})${keepLabel}`)
  }
  if (summary.binary) {
    lines.push(`  ✓ Binary: ${summary.binary}`)
  }
  if (summary.shellConfig) {
    lines.push(`  ✓ Shell config: ${summary.shellConfig}`)
  }
  if (summary.packageCommand) {
    lines.push(`  ✓ Package command: ${summary.packageCommand}`)
  }
  return lines
}

export const UninstallCommand = {
  command: "uninstall",
  describe: "uninstall lmplayer and remove all related files",
  builder: (yargs: Argv) =>
    yargs
      .option("keep-config", {
        alias: "c",
        type: "boolean",
        describe: "keep configuration files",
        default: false,
      })
      .option("keep-data", {
        alias: "d",
        type: "boolean",
        describe: "keep session data and snapshots",
        default: false,
      })
      .option("dry-run", {
        type: "boolean",
        describe: "show what would be removed without removing",
        default: false,
      })
      .option("force", {
        alias: "f",
        type: "boolean",
        describe: "skip confirmation prompts",
        default: false,
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write removal manifest or result to file path",
      })
      .option("json", {
        type: "boolean",
        describe: "output as JSON",
      }),

  handler: async (args: UninstallArgs) => {
    const keepConfig = Boolean(args.keepConfig || args.c || (args as any)["keep-config"])
    const keepData = Boolean(args.keepData || args.d || (args as any)["keep-data"])
    const dryRun = Boolean(args.dryRun || (args as any)["dry-run"])
    const force = Boolean(args.force || args.f)
    const output = args.output || args.o
    const isJson = Boolean(args.json)
    const normalizedArgs: UninstallArgs = {
      keepConfig,
      keepData,
      dryRun,
      force,
      output,
      json: isJson,
    }
    const method = await Installation.method()
    const targets = await collectRemovalTargets(normalizedArgs, method)

    if (isJson || output) {
      const summary = await buildUninstallSummary(normalizedArgs, method, targets)
      const jsonStr = JSON.stringify(summary, null, 2) + EOL
      const textLines = formatUninstallSummaryText(summary)
      const textStr = textLines.join(EOL) + EOL

      if (dryRun) {
        if (output) {
          await writeOutputFile(output, isJson ? jsonStr : textStr, "uninstall manifest")
          return
        }
        if (isJson) {
          process.stdout.write(jsonStr)
          return
        }
        for (const line of textLines) {
          UI.println(line)
        }
        return
      }

      if (!force) {
        const errResult = {
          executed: false,
          error: "Uninstallation requires --force when running with --json or --output without --dry-run",
          summary,
        }
        const errJsonStr = JSON.stringify(errResult, null, 2) + EOL
        if (output) {
          await writeOutputFile(output, errJsonStr, "uninstall result")
          return
        }
        process.stdout.write(errJsonStr)
        return
      }

      const errors = await executeUninstallProgrammatic(method, targets)
      const result = {
        executed: true,
        success: errors.length === 0,
        errors,
        summary,
      }
      const resultJsonStr = JSON.stringify(result, null, 2) + EOL
      const resultTextStr =
        errors.length === 0
          ? "Uninstallation complete" + EOL
          : `Uninstallation finished with errors: ${errors.join(", ")}` + EOL

      if (output) {
        await writeOutputFile(output, isJson ? resultJsonStr : resultTextStr, "uninstall result")
        return
      }
      process.stdout.write(resultJsonStr)
      return
    }

    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Uninstall lmplayer")

    prompts.log.info(`Installation method: ${method}`)

    await showRemovalSummary(targets, method)

    if (!force && !dryRun) {
      const confirm = await prompts.confirm({
        message: "Are you sure you want to uninstall?",
        initialValue: false,
      })
      if (!confirm || prompts.isCancel(confirm)) {
        prompts.outro("Cancelled")
        return
      }
    }

    if (dryRun) {
      prompts.log.warn("Dry run - no changes made")
      prompts.outro("Done")
      return
    }

    await executeUninstall(method, targets)

    prompts.outro("Done")
  },
}

async function collectRemovalTargets(args: UninstallArgs, method: Installation.Method): Promise<RemovalTargets> {
  const directories: RemovalTargets["directories"] = [
    { path: Global.Path.data, label: "Data", keep: Boolean(args.keepData) },
    { path: Global.Path.cache, label: "Cache", keep: false },
    { path: Global.Path.config, label: "Config", keep: Boolean(args.keepConfig) },
    { path: Global.Path.state, label: "State", keep: false },
  ]

  const shellConfig = method === "curl" ? await getShellConfigFile() : null
  const binary = method === "curl" ? process.execPath : null

  return { directories, shellConfig, binary }
}

async function showRemovalSummary(targets: RemovalTargets, method: Installation.Method) {
  prompts.log.message("The following will be removed:")

  for (const dir of targets.directories) {
    const exists = await fs
      .access(dir.path)
      .then(() => true)
      .catch(() => false)
    if (!exists) continue

    const size = await getDirectorySize(dir.path)
    const sizeStr = formatSize(size)
    const status = dir.keep ? UI.Style.TEXT_DIM + "(keeping)" : ""
    const prefix = dir.keep ? "○" : "✓"

    prompts.log.info(`  ${prefix} ${dir.label}: ${shortenPath(dir.path)} ${UI.Style.TEXT_DIM}(${sizeStr})${status}`)
  }

  if (targets.binary) {
    prompts.log.info(`  ✓ Binary: ${shortenPath(targets.binary)}`)
  }

  if (targets.shellConfig) {
    prompts.log.info(`  ✓ Shell PATH in ${shortenPath(targets.shellConfig)}`)
  }

  if (method !== "curl" && method !== "unknown") {
    const cmds: Record<string, string> = {
      npm: "npm uninstall -g opencode-ai",
      pnpm: "pnpm uninstall -g opencode-ai",
      bun: "bun remove -g opencode-ai",
      yarn: "yarn global remove opencode-ai",
      brew: "brew uninstall opencode",
      choco: "choco uninstall opencode",
      scoop: "scoop uninstall opencode",
    }
    prompts.log.info(`  ✓ Package: ${cmds[method] || method}`)
  }
}

async function executeUninstallProgrammatic(method: Installation.Method, targets: RemovalTargets): Promise<string[]> {
  const errors: string[] = []

  for (const dir of targets.directories) {
    if (dir.keep) continue
    const exists = await fs
      .access(dir.path)
      .then(() => true)
      .catch(() => false)
    if (!exists) continue

    try {
      await fs.rm(dir.path, { recursive: true, force: true })
    } catch (e) {
      errors.push(`${dir.label}: ${(e as Error).message}`)
    }
  }

  if (targets.shellConfig) {
    try {
      await cleanShellConfig(targets.shellConfig)
    } catch (e) {
      errors.push(`Shell config: ${(e as Error).message}`)
    }
  }

  if (method !== "curl" && method !== "unknown") {
    const cmds: Record<string, string[]> = {
      npm: ["npm", "uninstall", "-g", "opencode-ai"],
      pnpm: ["pnpm", "uninstall", "-g", "opencode-ai"],
      bun: ["bun", "remove", "-g", "opencode-ai"],
      yarn: ["yarn", "global", "remove", "opencode-ai"],
      brew: ["brew", "uninstall", "opencode"],
      choco: ["choco", "uninstall", "opencode"],
      scoop: ["scoop", "uninstall", "opencode"],
    }

    const cmd = cmds[method]
    if (cmd) {
      const result = await Process.run(method === "choco" ? ["choco", "uninstall", "opencode", "-y", "-r"] : cmd, {
        nothrow: true,
      })
      if (result.code !== 0) {
        errors.push(`Package manager uninstall failed: exit code ${result.code}`)
      }
    }
  }

  return errors
}

async function executeUninstall(method: Installation.Method, targets: RemovalTargets) {
  const spinner = prompts.spinner()
  const errors: string[] = []

  for (const dir of targets.directories) {
    if (dir.keep) {
      prompts.log.step(`Skipping ${dir.label} (--keep-${dir.label.toLowerCase()})`)
      continue
    }

    const exists = await fs
      .access(dir.path)
      .then(() => true)
      .catch(() => false)
    if (!exists) continue

    spinner.start(`Removing ${dir.label}...`)
    const err = await fs.rm(dir.path, { recursive: true, force: true }).catch((e) => e)
    if (err) {
      spinner.stop(`Failed to remove ${dir.label}`, 1)
      errors.push(`${dir.label}: ${err.message}`)
      continue
    }
    spinner.stop(`Removed ${dir.label}`)
  }

  if (targets.shellConfig) {
    spinner.start("Cleaning shell config...")
    const err = await cleanShellConfig(targets.shellConfig).catch((e) => e)
    if (err) {
      spinner.stop("Failed to clean shell config", 1)
      errors.push(`Shell config: ${err.message}`)
    } else {
      spinner.stop("Cleaned shell config")
    }
  }

  if (method !== "curl" && method !== "unknown") {
    const cmds: Record<string, string[]> = {
      npm: ["npm", "uninstall", "-g", "opencode-ai"],
      pnpm: ["pnpm", "uninstall", "-g", "opencode-ai"],
      bun: ["bun", "remove", "-g", "opencode-ai"],
      yarn: ["yarn", "global", "remove", "opencode-ai"],
      brew: ["brew", "uninstall", "opencode"],
      choco: ["choco", "uninstall", "opencode"],
      scoop: ["scoop", "uninstall", "opencode"],
    }

    const cmd = cmds[method]
    if (cmd) {
      spinner.start(`Running ${cmd.join(" ")}...`)
      const result = await Process.run(method === "choco" ? ["choco", "uninstall", "opencode", "-y", "-r"] : cmd, {
        nothrow: true,
      })
      if (result.code !== 0) {
        spinner.stop(`Package manager uninstall failed: exit code ${result.code}`, 1)
        const text = `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`
        if (method === "choco" && text.includes("not running from an elevated command shell")) {
          prompts.log.warn(`You may need to run '${cmd.join(" ")}' from an elevated command shell`)
        } else {
          prompts.log.warn(`You may need to run manually: ${cmd.join(" ")}`)
        }
      } else {
        spinner.stop("Package removed")
      }
    }
  }

  if (method === "curl" && targets.binary) {
    UI.empty()
    prompts.log.message("To finish removing the binary, run:")
    prompts.log.info(`  rm "${targets.binary}"`)

    const binDir = path.dirname(targets.binary)
    if (binDir.includes(".opencode") || binDir.includes(".lmcode") || binDir.includes(".lmplayer")) {
      prompts.log.info(`  rmdir "${binDir}" 2>/dev/null`)
    }
  }

  if (errors.length > 0) {
    UI.empty()
    prompts.log.warn("Some operations failed:")
    for (const err of errors) {
      prompts.log.error(`  ${err}`)
    }
  }

  UI.empty()
  prompts.log.success("Thank you for using lmplayer!")
}

async function getShellConfigFile(): Promise<string | null> {
  const shell = path.basename(process.env.SHELL || "bash")
  const home = os.homedir()
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, ".config")

  const configFiles: Record<string, string[]> = {
    fish: [path.join(xdgConfig, "fish", "config.fish")],
    zsh: [
      path.join(home, ".zshrc"),
      path.join(home, ".zshenv"),
      path.join(xdgConfig, "zsh", ".zshrc"),
      path.join(xdgConfig, "zsh", ".zshenv"),
    ],
    bash: [
      path.join(home, ".bashrc"),
      path.join(home, ".bash_profile"),
      path.join(home, ".profile"),
      path.join(xdgConfig, "bash", ".bashrc"),
      path.join(xdgConfig, "bash", ".bash_profile"),
    ],
    ash: [path.join(home, ".ashrc"), path.join(home, ".profile")],
    sh: [path.join(home, ".profile")],
  }

  const candidates = configFiles[shell] || configFiles.bash

  for (const file of candidates) {
    const exists = await fs
      .access(file)
      .then(() => true)
      .catch(() => false)
    if (!exists) continue

    const content = await Filesystem.readText(file).catch(() => "")
    if (
      content.includes("# opencode") ||
      content.includes("# lmcode") ||
      content.includes("# lmplayer") ||
      content.includes(".opencode/bin") ||
      content.includes(".lmcode/bin") ||
      content.includes(".lmplayer/bin")
    ) {
      return file
    }
  }

  return null
}

async function cleanShellConfig(file: string) {
  const content = await Filesystem.readText(file)
  const lines = content.split("\n")

  const filtered: string[] = []
  let skip = false

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed === "# opencode" || trimmed === "# lmcode" || trimmed === "# lmplayer") {
      skip = true
      continue
    }

    if (skip) {
      skip = false
      if (
        trimmed.includes(".opencode/bin") ||
        trimmed.includes(".lmcode/bin") ||
        trimmed.includes(".lmplayer/bin") ||
        trimmed.includes("fish_add_path")
      ) {
        continue
      }
    }

    if (
      (trimmed.startsWith("export PATH=") &&
        (trimmed.includes(".opencode/bin") ||
          trimmed.includes(".lmcode/bin") ||
          trimmed.includes(".lmplayer/bin"))) ||
      (trimmed.startsWith("fish_add_path") &&
        (trimmed.includes(".opencode") || trimmed.includes(".lmcode") || trimmed.includes(".lmplayer")))
    ) {
      continue
    }

    filtered.push(line)
  }

  while (filtered.length > 0 && filtered[filtered.length - 1].trim() === "") {
    filtered.pop()
  }

  const output = filtered.join("\n") + "\n"
  await Filesystem.write(file, output)
}

async function getDirectorySize(dir: string): Promise<number> {
  let total = 0

  const walk = async (current: string) => {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])

    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (entry.isFile()) {
        const stat = await fs.stat(full).catch(() => null)
        if (stat) total += stat.size
      }
    }
  }

  await walk(dir)
  return total
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function shortenPath(p: string): string {
  const home = os.homedir()
  if (p.startsWith(home)) {
    return p.replace(home, "~")
  }
  return p
}
