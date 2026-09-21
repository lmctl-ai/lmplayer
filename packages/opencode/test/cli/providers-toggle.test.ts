import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import fs from "fs/promises"
import { parse } from "jsonc-parser"
import { cliIt } from "../lib/cli-process"

const readGlobalConfig = async (home: string) => {
  const jsonc = path.join(home, ".config", "lmplayer", "opencode.jsonc")
  const json = path.join(home, ".config", "lmplayer", "opencode.json")
  if (await Bun.file(jsonc).exists()) return parse(await Bun.file(jsonc).text())
  return parse(await Bun.file(json).text())
}

describe("opencode providers enable / disable (non-interactive subprocess)", () => {
  cliIt.concurrent(
    "disables and enables a provider globally",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const disableResult = yield* opencode.spawn(["providers", "disable", "openai"])
        opencode.expectExit(disableResult, 0)

        const configAfterDisable = yield* Effect.promise(() => readGlobalConfig(home))
        expect(configAfterDisable.disabled_providers).toContain("openai")

        const enableResult = yield* opencode.spawn(["providers", "enable", "openai"])
        opencode.expectExit(enableResult, 0)

        const configAfterEnable = yield* Effect.promise(() => readGlobalConfig(home))
        expect(configAfterEnable.disabled_providers).not.toContain("openai")
      }),
    60_000,
  )

  cliIt.concurrent(
    "disables and enables a provider in project config",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const disableResult = yield* opencode.spawn(["providers", "disable", "anthropic", "--project"])
        opencode.expectExit(disableResult, 0)

        const configAfterDisable = yield* Effect.promise(() =>
          Bun.file(path.join(home, "opencode.json")).json(),
        )
        expect(configAfterDisable.disabled_providers).toContain("anthropic")

        const enableResult = yield* opencode.spawn(["providers", "enable", "anthropic", "-p"])
        opencode.expectExit(enableResult, 0)

        const configAfterEnable = yield* Effect.promise(() =>
          Bun.file(path.join(home, "opencode.json")).json(),
        )
        expect(configAfterEnable.disabled_providers).not.toContain("anthropic")
      }),
    60_000,
  )

  cliIt.concurrent(
    "works via provider alias",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const disableResult = yield* opencode.spawn(["provider", "disable", "google"])
        opencode.expectExit(disableResult, 0)

        const configAfterDisable = yield* Effect.promise(() => readGlobalConfig(home))
        expect(configAfterDisable.disabled_providers).toContain("google")

        const enableResult = yield* opencode.spawn(["provider", "enable", "google"])
        opencode.expectExit(enableResult, 0)

        const configAfterEnable = yield* Effect.promise(() => readGlobalConfig(home))
        expect(configAfterEnable.disabled_providers).not.toContain("google")
      }),
    60_000,
  )

  cliIt.concurrent(
    "fails when both --global and --project are specified",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn([
          "providers",
          "disable",
          "openai",
          "--global",
          "--project",
        ])
        opencode.expectExit(result, 1)
        expect(result.stderr).toContain("Cannot specify both global and project scope")
      }),
    60_000,
  )

  cliIt.concurrent(
    "disables and enables a provider with -o output file (text) and --output --json (json)",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const textOut = path.join(home, "disable-provider.txt")
        const disRes = yield* opencode.spawn(["providers", "disable", "google", "-o", textOut])
        opencode.expectExit(disRes, 0)
        expect(disRes.stderr).toContain("Wrote disable result to")
        const textContent = yield* Effect.promise(() => fs.readFile(textOut, "utf-8"))
        expect(textContent).toContain('Provider "google" disabled')

        const jsonOut = path.join(home, "enable-provider.json")
        const enRes = yield* opencode.spawn(["providers", "enable", "google", "--output", jsonOut, "--json"])
        opencode.expectExit(enRes, 0)
        expect(enRes.stderr).toContain("Wrote enable result to")
        const jsonContent = yield* Effect.promise(() => fs.readFile(jsonOut, "utf-8"))
        const parsedJson = JSON.parse(jsonContent)
        expect(parsedJson.ok).toBe(true)
        expect(parsedJson.provider).toBe("google")
        expect(parsedJson.enabled).toBe(true)
      }),
    60_000,
  )
})
