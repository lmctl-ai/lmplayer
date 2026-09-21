import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import fs from "node:fs/promises"
import { cliIt } from "../lib/cli-process"

async function createLocalPlugin(dir: string, name: string) {
  const pluginDir = path.join(dir, name)
  await fs.mkdir(pluginDir, { recursive: true })
  await fs.writeFile(
    path.join(pluginDir, "package.json"),
    JSON.stringify(
      {
        name,
        version: "1.0.0",
        main: "./index.js",
      },
      null,
      2,
    ),
    "utf-8",
  )
  await fs.writeFile(path.join(pluginDir, "index.js"), "module.exports = {}", "utf-8")
  return pluginDir
}

describe("opencode plugin (non-interactive subprocess)", () => {
  cliIt.concurrent(
    "installs a plugin with -o output file (text) and --output --json (json)",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const pluginDir1 = yield* Effect.promise(() => createLocalPlugin(home, "text-plugin"))
        const textOut = path.join(home, "install-plugin.txt")
        const resText = yield* opencode.spawn(["plugin", pluginDir1, "-o", textOut])
        opencode.expectExit(resText, 0)
        expect(resText.stderr).toContain("Wrote plugin install result to")
        const textContent = yield* Effect.promise(() => fs.readFile(textOut, "utf-8"))
        expect(textContent).toContain("Installed")

        const pluginDir2 = yield* Effect.promise(() => createLocalPlugin(home, "json-plugin"))
        const jsonOut = path.join(home, "install-plugin.json")
        const resJson = yield* opencode.spawn(["plugin", pluginDir2, "--output", jsonOut, "--json"])
        opencode.expectExit(resJson, 0)
        expect(resJson.stderr).toContain("Wrote plugin install result to")
        const jsonContent = yield* Effect.promise(() => fs.readFile(jsonOut, "utf-8"))
        const parsedJson = JSON.parse(jsonContent)
        expect(parsedJson.ok).toBe(true)
        expect(parsedJson.module).toBe(pluginDir2)
        expect(parsedJson.targets).toEqual(["server"])
      }),
    60_000,
  )

  cliIt.concurrent(
    "installs a plugin with --json writing to stdout",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const pluginDir = yield* Effect.promise(() => createLocalPlugin(home, "stdout-json-plugin"))
        const res = yield* opencode.spawn(["plugin", pluginDir, "--json"])
        opencode.expectExit(res, 0)
        const parsedJson = JSON.parse(res.stdout)
        expect(parsedJson.ok).toBe(true)
        expect(parsedJson.module).toBe(pluginDir)
      }),
    60_000,
  )
})
