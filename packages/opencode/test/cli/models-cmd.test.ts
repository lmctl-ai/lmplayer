import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import fs from "node:fs/promises"
import yargs, { type Argv } from "yargs"
import {
  ModelsCommand,
  ModelsListCommand,
  ModelsVerifyCommand,
  ModelsTestCommand,
  ModelsShowCommand,
  parseModelFilters,
} from "../../src/cli/cmd/models"
import { cliIt } from "../lib/cli-process"

describe("opencode models test / verify (cli subprocess)", () => {
  cliIt.concurrent(
    "models verify rejects invalid format or unknown provider",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["models", "verify", "unknown-provider/unknown-model"])
        opencode.expectExit(result, 1)
        expect(result.stderr).toContain('unknown provider "unknown-provider"')
      }),
    60_000,
  )

  cliIt.concurrent(
    "models verify supports --json output for valid and invalid models",
    ({ opencode }) =>
      Effect.gen(function* () {
        const failResult = yield* opencode.spawn(["models", "verify", "unknown-provider/unknown-model", "--json"])
        opencode.expectExit(failResult, 1)
        const parsedFail = JSON.parse(failResult.stdout)
        expect(parsedFail.ok).toBe(false)
        expect(parsedFail.model).toBe("unknown-provider/unknown-model")
        expect(parsedFail.reason).toContain('unknown provider "unknown-provider"')

        const okResult = yield* opencode.spawn(["models", "verify", "ollama/llama3", "--json"])
        opencode.expectExit(okResult, 0)
        const parsedOk = JSON.parse(okResult.stdout)
        expect(parsedOk.ok).toBe(true)
        expect(parsedOk.model).toBe("ollama/llama3")
      }),
    60_000,
  )

  cliIt.concurrent(
    "models verify supports --output file export",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const outFile = path.join(home, "model-verify.json")
        const result = yield* opencode.spawn(["models", "verify", "ollama/llama3", "--json", "-o", outFile])
        opencode.expectExit(result, 0)
        const fileContent = JSON.parse(yield* Effect.promise(() => fs.readFile(outFile, "utf-8")))
        expect(fileContent.ok).toBe(true)
        expect(fileContent.model).toBe("ollama/llama3")
      }),
    60_000,
  )

  cliIt.concurrent(
    "models test rejects nonexistent provider",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["models", "test", "nonexistent-provider"])
        opencode.expectExit(result, 1)
        expect(result.stderr).toContain("Provider not found: nonexistent-provider")
      }),
    60_000,
  )

  cliIt.concurrent(
    "models list --json outputs JSON array of models",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["models", "list", "--json"])
        opencode.expectExit(result, 0)
        const parsed = JSON.parse(result.stdout)
        expect(Array.isArray(parsed)).toBe(true)
        expect(parsed.length).toBeGreaterThan(0)
        expect(parsed[0].id).toBeDefined()
        expect(parsed[0].provider).toBeDefined()
      }),
    60_000,
  )

  cliIt.concurrent(
    "models ls alias supports search filtering",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["models", "ls", "-q", "qwen", "--json"])
        opencode.expectExit(result, 0)
        const parsed = JSON.parse(result.stdout)
        expect(Array.isArray(parsed)).toBe(true)
        for (const entry of parsed) {
          const matches =
            entry.id.toLowerCase().includes("qwen") ||
            entry.name.toLowerCase().includes("qwen") ||
            entry.provider.toLowerCase().includes("qwen")
          expect(matches).toBe(true)
        }
      }),
    60_000,
  )

  cliIt.concurrent(
    "models list rejects nonexistent provider",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["models", "list", "nonexistent-provider-xyz"])
        opencode.expectExit(result, 1)
        expect(result.stderr).toContain("Provider not found: nonexistent-provider-xyz")
      }),
    60_000,
  )
})

describe("models command builders and option parsing", () => {
  test("parseModelFilters handles search, reasoning, toolcall, attachment, and min-context (ctx)", () => {
    const filters = parseModelFilters({
      q: "claude",
      r: true,
      tools: true,
      attachments: true,
      ctx: 128000,
    })
    expect(filters.search).toBe("claude")
    expect(filters.reasoning).toBe(true)
    expect(filters.toolcall).toBe(true)
    expect(filters.attachment).toBe(true)
    expect(filters.minContext).toBe(128000)
  })

  test("ModelsListCommand registers search, reasoning, toolcall, attachment, min-context, ctx, output, and json options", () => {
    const builder = ModelsListCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.search).toBeDefined()
    expect(options.key.q).toBeDefined()
    expect(options.key.reasoning).toBeDefined()
    expect(options.key.r).toBeDefined()
    expect(options.key.toolcall).toBeDefined()
    expect(options.key.tools).toBeDefined()
    expect(options.key.attachment).toBeDefined()
    expect(options.key.attachments).toBeDefined()
    expect(options.key["min-context"]).toBeDefined()
    expect(options.key.ctx).toBeDefined()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
  })

  test("ModelsListCommand parses options from arguments", async () => {
    const builder = ModelsListCommand.builder as (y: Argv) => Argv<any>
    const parsed = await builder(yargs()).parseAsync([
      "-q",
      "gpt",
      "-r",
      "--tools",
      "--attachments",
      "--ctx",
      "200000",
      "-o",
      "models.json",
      "--json",
    ])
    expect(parsed.q).toBe("gpt")
    expect(parsed.r).toBe(true)
    expect(parsed.tools).toBe(true)
    expect(parsed.attachments).toBe(true)
    expect(parsed.ctx).toBe(200000)
    expect(parsed.output).toBe("models.json")
    expect(parsed.json).toBe(true)
  })

  test("ModelsVerifyCommand registers model, effort, output, and json options", () => {
    const builder = ModelsVerifyCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.model).toBeDefined()
    expect(options.key.effort).toBeDefined()
    expect(options.key.e).toBeDefined()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
  })

  test("ModelsTestCommand registers provider, output, json, timeout, and concurrency options", () => {
    const builder = ModelsTestCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.provider).toBeDefined()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
    expect(options.key.timeout).toBeDefined()
    expect(options.key.concurrency).toBeDefined()
  })

  test("ModelsShowCommand registers model, output, and json options", () => {
    const builder = ModelsShowCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.model).toBeDefined()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
  })
})

