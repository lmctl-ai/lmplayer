import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import fs from "node:fs/promises"
import yargs, { type Argv } from "yargs"
import { cliIt } from "../lib/cli-process"
import {
  ProvidersCommand,
  ProvidersListCommand,
  ProvidersShowCommand,
  ProvidersLoginCommand,
  ProvidersLogoutCommand,
  ProvidersEnableCommand,
  ProvidersDisableCommand,
} from "../../src/cli/cmd/providers"

describe("providers CLI command builder and option parsing", () => {
  test("ProvidersCommand registers all subcommands and aliases", () => {
    expect(ProvidersCommand.command).toBe("providers")
    expect(ProvidersCommand.aliases).toEqual(["auth", "provider"])
  })

  test("ProvidersListCommand registers options and parses aliases correctly", () => {
    const builder = ProvidersListCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.json).toBeDefined()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.search).toBeDefined()
    expect(options.key.q).toBeDefined()
    expect(options.key.query).toBeDefined()
    expect(options.key.all).toBeDefined()
    expect(options.key.a).toBeDefined()

    const parsed = parser.parseSync(["-q", "anthropic", "-a", "-o", "out.json", "--json"])
    expect(parsed.search).toBe("anthropic")
    expect(parsed.q).toBe("anthropic")
    expect(parsed.all).toBe(true)
    expect(parsed.a).toBe(true)
    expect(parsed.output).toBe("out.json")
    expect(parsed.o).toBe("out.json")
    expect(parsed.json).toBe(true)
  })

  test("ProvidersShowCommand registers options and parses aliases correctly", async () => {
    const builder = ProvidersShowCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.json).toBeDefined()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()

    const parsed = await yargs()
      .command({ ...ProvidersShowCommand, handler: () => {} })
      .parseAsync(["show", "anthropic", "-o", "out.json", "--json"])
    expect(parsed.provider).toBe("anthropic")
    expect(parsed.output).toBe("out.json")
    expect(parsed.o).toBe("out.json")
    expect(parsed.json).toBe(true)
  })

  test("ProvidersLoginCommand registers options and parses aliases correctly", () => {
    const builder = ProvidersLoginCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.provider).toBeDefined()
    expect(options.key.p).toBeDefined()
    expect(options.key.method).toBeDefined()
    expect(options.key.m).toBeDefined()
    expect(options.key.key).toBeDefined()
    expect(options.key.k).toBeDefined()
    expect(options.key["api-key"]).toBeDefined()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()

    const parsed = parser.parseSync(["-p", "anthropic", "-m", "api", "-k", "sk-secret", "-o", "out.json", "--json"])
    expect(parsed.provider).toBe("anthropic")
    expect(parsed.p).toBe("anthropic")
    expect(parsed.method).toBe("api")
    expect(parsed.m).toBe("api")
    expect(parsed.key).toBe("sk-secret")
    expect(parsed.k).toBe("sk-secret")
    expect(parsed.output).toBe("out.json")
    expect(parsed.o).toBe("out.json")
    expect(parsed.json).toBe(true)
  })

  test("ProvidersLogoutCommand registers options and parses aliases correctly", async () => {
    const builder = ProvidersLogoutCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.provider).toBeDefined()
    expect(options.key.p).toBeDefined()
    expect(options.key.force).toBeDefined()
    expect(options.key.f).toBeDefined()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()

    const parsed = await yargs()
      .command({ ...ProvidersLogoutCommand, handler: () => {} })
      .parseAsync(["logout", "anthropic", "-f", "-o", "out.json", "--json"])
    expect(parsed.provider).toBe("anthropic")
    expect(parsed.force).toBe(true)
    expect(parsed.f).toBe(true)
    expect(parsed.output).toBe("out.json")
    expect(parsed.o).toBe("out.json")
    expect(parsed.json).toBe(true)

    const parsedOption = await yargs()
      .command({ ...ProvidersLogoutCommand, handler: () => {} })
      .parseAsync(["logout", "-p", "openai", "-f"])
    expect(parsedOption.provider).toBe("openai")
    expect(parsedOption.p).toBe("openai")
    expect(parsedOption.force).toBe(true)
  })

  test("ProvidersEnableCommand and ProvidersDisableCommand register scope options and validate conflicts", async () => {
    for (const [cmd, name] of [
      [ProvidersEnableCommand, "enable"] as const,
      [ProvidersDisableCommand, "disable"] as const,
    ]) {
      const builder = cmd.builder as (y: Argv) => Argv<any>
      const parser = builder(yargs().exitProcess(false))
      const options = (parser as any).getOptions()
      expect(options.key.scope).toBeDefined()
      expect(options.key.s).toBeDefined()
      expect(options.key.global).toBeDefined()
      expect(options.key.g).toBeDefined()
      expect(options.key.project).toBeDefined()
      expect(options.key.p).toBeDefined()
      expect(options.key.output).toBeDefined()
      expect(options.key.o).toBeDefined()
      expect(options.key.json).toBeDefined()

      const cmdParser = () =>
        yargs()
          .exitProcess(false)
          .fail((msg, err) => {
            throw err ?? new Error(msg)
          })
          .command({ ...cmd, handler: () => {} })

      const parsedShort = await cmdParser().parseAsync([name, "anthropic", "-s", "project", "-o", "out.json", "--json"])
      expect(parsedShort.provider).toBe("anthropic")
      expect(parsedShort.scope).toBe("project")
      expect(parsedShort.s).toBe("project")
      expect(parsedShort.output).toBe("out.json")
      expect(parsedShort.o).toBe("out.json")
      expect(parsedShort.json).toBe(true)

      const parsedG = await cmdParser().parseAsync([name, "anthropic", "-g"])
      expect(parsedG.global).toBe(true)
      expect(parsedG.g).toBe(true)

      const parsedP = await cmdParser().parseAsync([name, "anthropic", "-p"])
      expect(parsedP.project).toBe(true)
      expect(parsedP.p).toBe(true)

      // Conflict checks
      await expect(async () => {
        await cmdParser().parseAsync([name, "anthropic", "-p", "-g"])
      }).toThrow("Cannot specify both global and project scope")
      await expect(async () => {
        await cmdParser().parseAsync([name, "anthropic", "-s", "project", "-g"])
      }).toThrow("Cannot specify both --scope and --project/--global")
      await expect(async () => {
        await cmdParser().parseAsync([name, "anthropic", "--scope", "global", "--project"])
      }).toThrow("Cannot specify both --scope and --project/--global")
    }
  })
})

describe("opencode providers / auth CLI subprocess", () => {
  cliIt.concurrent(
    "providers list --json outputs credentials path and providers list",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["providers", "list", "--json"])
        opencode.expectExit(result, 0)
        const parsed = JSON.parse(result.stdout)
        expect(parsed.credentials_path).toBeDefined()
        expect(Array.isArray(parsed.providers)).toBe(true)
      }),
    60_000,
  )

  cliIt.concurrent(
    "providers list supports --output file export",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const outFile = path.join(home, "providers.json")
        const result = yield* opencode.spawn(["providers", "list", "--json", "-o", outFile])
        opencode.expectExit(result, 0)
        const content = JSON.parse(yield* Effect.promise(() => fs.readFile(outFile, "utf-8")))
        expect(content.credentials_path).toBeDefined()
        expect(Array.isArray(content.providers)).toBe(true)
      }),
    60_000,
  )

  cliIt.concurrent(
    "providers list supports search query and --all catalog listing",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["providers", "list", "-q", "anthropic", "--all", "--json"])
        opencode.expectExit(result, 0)
        const parsed = JSON.parse(result.stdout)
        expect(Array.isArray(parsed.providers)).toBe(true)
        expect(parsed.providers.length).toBeGreaterThan(0)
        expect(parsed.providers.some((p: any) => p.id === "anthropic")).toBe(true)
      }),
    60_000,
  )

  cliIt.concurrent(
    "providers show supports --json and --output",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const outFile = path.join(home, "anthropic.json")
        const result = yield* opencode.spawn(["providers", "show", "anthropic", "--json", "-o", outFile])
        opencode.expectExit(result, 0)
        const content = JSON.parse(yield* Effect.promise(() => fs.readFile(outFile, "utf-8")))
        expect(content.id).toBe("anthropic")
        expect(content.name).toBe("Anthropic")
        expect(content.status).toBe("enabled")
      }),
    60_000,
  )

  cliIt.concurrent(
    "providers logout handles non-interactive mode and unknown provider cleanly",
    ({ opencode }) =>
      Effect.gen(function* () {
        // Without provider in non-interactive mode: fails
        const noProvResult = yield* opencode.spawn(["providers", "logout", "--json"])
        opencode.expectExit(noProvResult, 1)
        const noProvParsed = JSON.parse(noProvResult.stdout)
        expect(noProvParsed.ok).toBe(false)
        expect(noProvParsed.error).toContain("non-interactive")

        // Unknown provider without --force: fails
        const failResult = yield* opencode.spawn(["providers", "logout", "nonexistent-xyz", "--json"])
        opencode.expectExit(failResult, 1)
        const failParsed = JSON.parse(failResult.stdout)
        expect(failParsed.ok).toBe(false)

        // Unknown provider with --force: succeeds
        const forceResult = yield* opencode.spawn(["providers", "logout", "nonexistent-xyz", "--force", "--json"])
        opencode.expectExit(forceResult, 0)
        const forceParsed = JSON.parse(forceResult.stdout)
        expect(forceParsed.ok).toBe(true)
        expect(forceParsed.removed).toBe(false)
      }),
    60_000,
  )
})
