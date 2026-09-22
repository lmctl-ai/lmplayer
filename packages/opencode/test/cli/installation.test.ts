import { describe, expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"
import { buildUpgradeInfo, formatUpgradeInfoText } from "../../src/cli/cmd/upgrade"
import { formatUninstallSummaryText, type UninstallSummary } from "../../src/cli/cmd/uninstall"

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
