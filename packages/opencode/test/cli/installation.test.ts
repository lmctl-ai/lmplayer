import { describe, expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { Effect } from "effect"
import yargs, { type Argv } from "yargs"
import { cliIt } from "../lib/cli-process"
import { UpgradeCommand, buildUpgradeInfo, formatUpgradeInfoText } from "../../src/cli/cmd/upgrade"
import { UninstallCommand, formatUninstallSummaryText, type UninstallSummary } from "../../src/cli/cmd/uninstall"

describe("installation upgrade & uninstall unit helpers", () => {
  test("buildUpgradeInfo detects up to date status", () => {
    const info = buildUpgradeInfo({
      current: "0.1.48",
      latest: "0.1.48",
      method: "curl",
    })
    expect(info.upToDate).toBe(true)
    expect(info.upgradeAvailable).toBe(false)
    expect(info.target).toBe("0.1.48")
  })

  test("buildUpgradeInfo detects upgrade available and strips v prefix", () => {
    const info = buildUpgradeInfo({
      current: "0.1.48",
      latest: "0.1.50",
      target: "v0.1.50",
      method: "bun",
    })
    expect(info.upToDate).toBe(false)
    expect(info.upgradeAvailable).toBe(true)
    expect(info.target).toBe("0.1.50")
  })

  test("formatUpgradeInfoText formats up to date and available statuses", () => {
    const infoUpToDate = buildUpgradeInfo({
      current: "0.1.48",
      latest: "0.1.48",
      method: "curl",
    })
    const lines1 = formatUpgradeInfoText(infoUpToDate)
    expect(lines1).toContain("Current version: 0.1.48")
    expect(lines1).toContain("Status:          Up to date (0.1.48)")

    const infoAvailable = buildUpgradeInfo({
      current: "0.1.48",
      latest: "0.1.50",
      method: "npm",
    })
    const lines2 = formatUpgradeInfoText(infoAvailable)
    expect(lines2).toContain("Current version: 0.1.48")
    expect(lines2).toContain("Latest version:  0.1.50")
    expect(lines2).toContain("Status:          Upgrade available (0.1.48 → 0.1.50)")
  })

  test("formatUninstallSummaryText formats removal targets and details", () => {
    const summary: UninstallSummary = {
      method: "curl",
      dryRun: true,
      directories: [
        {
          path: "/tmp/data",
          label: "Data",
          keep: false,
          exists: true,
          size: 1024,
          sizeFormatted: "1.00 KB",
        },
        {
          path: "/tmp/config",
          label: "Config",
          keep: true,
          exists: true,
          size: 512,
          sizeFormatted: "512 B",
        },
      ],
      binary: "/tmp/bin/lmplayer",
      shellConfig: "/tmp/.bashrc",
      packageCommand: null,
    }

    const lines = formatUninstallSummaryText(summary)
    expect(lines).toContain("Installation method: curl")
    expect(lines.some((l) => l.includes("Data:") && l.includes("1.00 KB"))).toBe(true)
    expect(lines.some((l) => l.includes("Config:") && l.includes("(keeping)"))).toBe(true)
    expect(lines.some((l) => l.includes("Binary:") && l.includes("/tmp/bin/lmplayer"))).toBe(true)
    expect(lines.some((l) => l.includes("Shell config:") && l.includes("/tmp/.bashrc"))).toBe(true)
  })
})

describe("UpgradeCommand and UninstallCommand builders & options", () => {
  test("UpgradeCommand registers command, check, method, output, o, and json options", () => {
    expect(UpgradeCommand.command).toBe("upgrade [target]")
    const builder = UpgradeCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.check).toBeDefined()
    expect(options.key.c).toBeDefined()
    expect(options.key.method).toBeDefined()
    expect(options.key.m).toBeDefined()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
  })

  test("UpgradeCommand parses check, output, and json options", async () => {
    const builder = UpgradeCommand.builder as (y: Argv) => Argv<any>
    const parsed = await builder(yargs()).parseAsync([
      "--check",
      "--output",
      "upgrade.json",
      "--json",
    ])
    expect(parsed.check).toBe(true)
    expect(parsed.output).toBe("upgrade.json")
    expect(parsed.json).toBe(true)
  })

  test("UpgradeCommand parses -c and -o short aliases", async () => {
    const builder = UpgradeCommand.builder as (y: Argv) => Argv<any>
    const parsed = await builder(yargs()).parseAsync(["-c", "-o", "upgrade.txt"])
    expect(parsed.check).toBe(true)
    expect(parsed.output).toBe("upgrade.txt")
  })

  test("UninstallCommand registers command, dry-run, force, output, o, and json options", () => {
    expect(UninstallCommand.command).toBe("uninstall")
    const builder = UninstallCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key["dry-run"]).toBeDefined()
    expect(options.key.force).toBeDefined()
    expect(options.key.f).toBeDefined()
    expect(options.key["keep-config"]).toBeDefined()
    expect(options.key.c).toBeDefined()
    expect(options.key["keep-data"]).toBeDefined()
    expect(options.key.d).toBeDefined()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
  })

  test("UninstallCommand parses dry-run, force, output, and json options", async () => {
    const builder = UninstallCommand.builder as (y: Argv) => Argv<any>
    const parsed = await builder(yargs()).parseAsync([
      "--dry-run",
      "--force",
      "--output",
      "manifest.json",
      "--json",
    ])
    expect(parsed["dry-run"]).toBe(true)
    expect(parsed.force).toBe(true)
    expect(parsed.output).toBe("manifest.json")
    expect(parsed.json).toBe(true)
  })

  test("UninstallCommand parses -f and -o short aliases", async () => {
    const builder = UninstallCommand.builder as (y: Argv) => Argv<any>
    const parsed = await builder(yargs()).parseAsync(["-f", "-o", "manifest.txt"])
    expect(parsed.force).toBe(true)
    expect(parsed.output).toBe("manifest.txt")
  })

  test("UninstallCommand parses -c, -d, -f, and -o short aliases", async () => {
    const builder = UninstallCommand.builder as (y: Argv) => Argv<any>
    const parsed = await builder(yargs()).parseAsync(["-c", "-d", "-f", "-o", "manifest.json", "--json"])
    expect(parsed.c).toBe(true)
    expect(parsed.d).toBe(true)
    expect(parsed.f).toBe(true)
    expect(parsed.o).toBe("manifest.json")
    expect(parsed.json).toBe(true)
  })
})

describe("upgrade and uninstall CLI subprocess tests", () => {
  cliIt.concurrent(
    "upgrade --check supports -o text and json export",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        // Direct JSON stdout
        const stdoutRes = yield* opencode.spawn(["upgrade", "--check", "--json"])
        opencode.expectExit(stdoutRes, 0)
        const parsed = JSON.parse(stdoutRes.stdout.trim())
        expect(parsed).toHaveProperty("current")
        expect(parsed).toHaveProperty("latest")
        expect(parsed).toHaveProperty("target")
        expect(parsed).toHaveProperty("method")
        expect(parsed).toHaveProperty("upToDate")
        expect(parsed).toHaveProperty("upgradeAvailable")

        // File JSON output
        const jsonOut = path.join(home, "upgrade-check.json")
        const resJson = yield* opencode.spawn(["upgrade", "--check", "-o", jsonOut, "--json"])
        opencode.expectExit(resJson, 0)
        expect(resJson.stderr).toContain("Wrote upgrade info to")
        const jsonContent = yield* Effect.promise(() => fs.readFile(jsonOut, "utf-8"))
        const parsedFile = JSON.parse(jsonContent.trim())
        expect(parsedFile).toHaveProperty("current")
        expect(parsedFile).toHaveProperty("method")

        // File text output
        const textOut = path.join(home, "upgrade-check.txt")
        const resText = yield* opencode.spawn(["upgrade", "--check", "-o", textOut])
        opencode.expectExit(resText, 0)
        expect(resText.stderr).toContain("Wrote upgrade info to")
        const textContent = yield* Effect.promise(() => fs.readFile(textOut, "utf-8"))
        expect(textContent).toContain("Current version:")
        expect(textContent).toContain("Latest version:")
        expect(textContent).toContain("Method:")
      }),
    60_000,
  )

  cliIt.concurrent(
    "uninstall --dry-run supports -o text and json export",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        // Direct JSON stdout
        const stdoutRes = yield* opencode.spawn(["uninstall", "--dry-run", "--json"])
        opencode.expectExit(stdoutRes, 0)
        const parsed = JSON.parse(stdoutRes.stdout.trim())
        expect(parsed).toHaveProperty("method")
        expect(parsed.dryRun).toBe(true)
        expect(parsed).toHaveProperty("directories")
        expect(Array.isArray(parsed.directories)).toBe(true)

        // File JSON output
        const jsonOut = path.join(home, "uninstall-dryrun.json")
        const resJson = yield* opencode.spawn(["uninstall", "--dry-run", "-o", jsonOut, "--json"])
        opencode.expectExit(resJson, 0)
        expect(resJson.stderr).toContain("Wrote uninstall manifest to")
        const jsonContent = yield* Effect.promise(() => fs.readFile(jsonOut, "utf-8"))
        const parsedFile = JSON.parse(jsonContent.trim())
        expect(parsedFile.dryRun).toBe(true)
        expect(parsedFile).toHaveProperty("directories")

        // File text output
        const textOut = path.join(home, "uninstall-dryrun.txt")
        const resText = yield* opencode.spawn(["uninstall", "--dry-run", "-o", textOut])
        opencode.expectExit(resText, 0)
        expect(resText.stderr).toContain("Wrote uninstall manifest to")
        const textContent = yield* Effect.promise(() => fs.readFile(textOut, "utf-8"))
        expect(textContent).toContain("Installation method:")
        expect(textContent).toContain("Removal targets:")
      }),
    60_000,
  )
})
