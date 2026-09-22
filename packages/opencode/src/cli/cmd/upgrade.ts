import type { Argv } from "yargs"
import path from "node:path"
import { EOL } from "node:os"
import fs from "node:fs/promises"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { Installation } from "../../installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"

async function writeOutputFile(filePath: string, content: string, label: string) {
  const resolved = path.resolve(filePath)
  await fs.mkdir(path.dirname(resolved), { recursive: true })
  await fs.writeFile(resolved, content, "utf-8")
  UI.println(`Wrote ${label} to ${resolved}`)
}

export interface UpgradeInfo {
  current: string
  latest: string
  target: string
  method: Installation.Method
  upToDate: boolean
  upgradeAvailable: boolean
}

export interface UpgradeResult {
  current: string
  target: string
  method: Installation.Method
  upToDate: boolean
  upgraded: boolean
  success: boolean
  error?: string
  message?: string
}

export function buildUpgradeInfo(opts: {
  current: string
  latest: string
  target?: string
  method: Installation.Method
}): UpgradeInfo {
  const target = opts.target ? opts.target.replace(/^v/, "") : opts.latest
  const upToDate = opts.current === target
  return {
    current: opts.current,
    latest: opts.latest,
    target,
    method: opts.method,
    upToDate,
    upgradeAvailable: !upToDate,
  }
}

export function formatUpgradeInfoText(info: UpgradeInfo): string[] {
  const lines: string[] = []
  lines.push(`Current version: ${info.current}`)
  lines.push(`Latest version:  ${info.latest}`)
  if (info.target !== info.latest) {
    lines.push(`Target version:  ${info.target}`)
  }
  lines.push(`Method:          ${info.method}`)
  lines.push(
    info.upToDate
      ? `Status:          Up to date (${info.current})`
      : `Status:          Upgrade available (${info.current} → ${info.target})`,
  )
  return lines
}

export const UpgradeCommand = {
  command: "upgrade [target]",
  describe: "upgrade lmplayer to the latest or a specific version",
  builder: (yargs: Argv) => {
    return yargs
      .positional("target", {
        describe: "version to upgrade to, for ex '0.1.48' or 'v0.1.48'",
        type: "string",
      })
      .option("method", {
        alias: "m",
        describe: "installation method to use",
        type: "string",
        choices: ["curl", "npm", "pnpm", "bun", "brew", "choco", "scoop"],
      })
      .option("check", {
        alias: "c",
        type: "boolean",
        describe: "check for available upgrade without installing",
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write upgrade info or result to file path",
      })
      .option("json", {
        type: "boolean",
        describe: "output as JSON",
      })
  },
  handler: async (args: {
    target?: string
    method?: string
    check?: boolean
    output?: string
    json?: boolean
  }) => {
    const detectedMethod = await Installation.method()
    const method = (args.method as Installation.Method) ?? detectedMethod

    if (args.check) {
      const latest = await Installation.latest(method === "unknown" ? undefined : method).catch(
        () => InstallationVersion,
      )
      const info = buildUpgradeInfo({
        current: InstallationVersion,
        latest,
        target: args.target,
        method,
      })

      const jsonStr = JSON.stringify(info, null, 2) + EOL
      const textLines = formatUpgradeInfoText(info)
      const textStr = textLines.join(EOL) + EOL

      if (args.output) {
        await writeOutputFile(args.output, args.json ? jsonStr : textStr, "upgrade info")
        return
      }

      if (args.json) {
        process.stdout.write(jsonStr)
        return
      }

      for (const line of textLines) {
        UI.println(line)
      }
      return
    }

    const target = args.target ? args.target.replace(/^v/, "") : await Installation.latest()

    if (args.json || args.output) {
      if (method === "unknown") {
        const result: UpgradeResult = {
          current: InstallationVersion,
          target,
          method,
          upToDate: false,
          upgraded: false,
          success: false,
          error: `lmplayer is installed to ${process.execPath} and may be managed by an unknown package manager`,
        }
        const jsonStr = JSON.stringify(result, null, 2) + EOL
        if (args.output) {
          await writeOutputFile(args.output, jsonStr, "upgrade result")
          return
        }
        process.stdout.write(jsonStr)
        return
      }

      if (InstallationVersion === target) {
        const result: UpgradeResult = {
          current: InstallationVersion,
          target,
          method,
          upToDate: true,
          upgraded: false,
          success: true,
          message: `${target} is already installed`,
        }
        const jsonStr = JSON.stringify(result, null, 2) + EOL
        const textStr = `${target} is already installed` + EOL
        if (args.output) {
          await writeOutputFile(args.output, args.json ? jsonStr : textStr, "upgrade result")
          return
        }
        process.stdout.write(jsonStr)
        return
      }

      const err = await Installation.upgrade(method, target).catch((err) => err)
      if (err) {
        let errMsg = String(err instanceof Error ? err.message : err)
        if (err instanceof Installation.UpgradeFailedError) {
          errMsg = err.stderr
        }
        const result: UpgradeResult = {
          current: InstallationVersion,
          target,
          method,
          upToDate: false,
          upgraded: false,
          success: false,
          error: errMsg,
        }
        const jsonStr = JSON.stringify(result, null, 2) + EOL
        if (args.output) {
          await writeOutputFile(args.output, jsonStr, "upgrade result")
          return
        }
        process.stdout.write(jsonStr)
        return
      }

      const result: UpgradeResult = {
        current: InstallationVersion,
        target,
        method,
        upToDate: false,
        upgraded: true,
        success: true,
      }
      const jsonStr = JSON.stringify(result, null, 2) + EOL
      const textStr = `Upgraded to ${target}` + EOL
      if (args.output) {
        await writeOutputFile(args.output, args.json ? jsonStr : textStr, "upgrade result")
        return
      }
      process.stdout.write(jsonStr)
      return
    }

    // Interactive CLI mode
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Upgrade")

    if (method === "unknown") {
      prompts.log.error(`lmplayer is installed to ${process.execPath} and may be managed by a package manager`)
      const install = await prompts.select({
        message: "Install anyways?",
        options: [
          { label: "Yes", value: true },
          { label: "No", value: false },
        ],
        initialValue: false,
      })
      if (!install) {
        prompts.outro("Done")
        return
      }
    }
    prompts.log.info("Using method: " + method)

    if (InstallationVersion === target) {
      prompts.log.warn(`lmplayer upgrade skipped: ${target} is already installed`)
      prompts.outro("Done")
      return
    }

    prompts.log.info(`From ${InstallationVersion} → ${target}`)
    const spinner = prompts.spinner()
    spinner.start("Upgrading...")
    const err = await Installation.upgrade(method, target).catch((err) => err)
    if (err) {
      spinner.stop("Upgrade failed", 1)
      if (err instanceof Installation.UpgradeFailedError) {
        // necessary because choco only allows install/upgrade in elevated terminals
        if (method === "choco" && err.stderr.includes("not running from an elevated command shell")) {
          prompts.log.error("Please run the terminal as Administrator and try again")
        } else {
          prompts.log.error(err.stderr)
        }
      } else if (err instanceof Error) prompts.log.error(err.message)
      prompts.outro("Done")
      return
    }
    spinner.stop("Upgrade complete")
    prompts.outro("Done")
  },
}
