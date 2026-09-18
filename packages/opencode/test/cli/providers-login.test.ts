import { describe, expect, test, spyOn } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { resolveApiKey, ProvidersLoginCommand } from "../../src/cli/cmd/providers"
import { CliError } from "../../src/cli/effect-cmd"
import yargs, { type Argv } from "yargs"

describe("resolveApiKey", () => {
  test("returns trimmed API key when direct keyArg is passed", async () => {
    const key = await Effect.runPromise(resolveApiKey("  sk-ant-test-key-123  "))
    expect(key).toBe("sk-ant-test-key-123")
  })

  test("fails when keyArg is whitespace only", async () => {
    const exit = await Effect.runPromiseExit(resolveApiKey("   \t  "))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause)
      expect(error).toBeInstanceOf(CliError)
      expect((error as CliError).message).toBe("API key cannot be empty")
    }
  })

  test("reads key from stdin when keyArg is '-'", async () => {
    const stdinSpy = spyOn(Bun.stdin, "text").mockResolvedValueOnce("  sk-stdin-pipe-456\n")
    try {
      const key = await Effect.runPromise(resolveApiKey("-"))
      expect(key).toBe("sk-stdin-pipe-456")
    } finally {
      stdinSpy.mockRestore()
    }
  })

  test("fails when keyArg is '-' and stdin is empty", async () => {
    const stdinSpy = spyOn(Bun.stdin, "text").mockResolvedValueOnce("   \n")
    try {
      const exit = await Effect.runPromiseExit(resolveApiKey("-"))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(CliError)
        expect((error as CliError).message).toBe("No API key provided via stdin")
      }
    } finally {
      stdinSpy.mockRestore()
    }
  })

  test("reads key from piped stdin in non-TTY mode when keyArg is not provided", async () => {
    const originalIsTTY = process.stdin.isTTY
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true })
    const stdinSpy = spyOn(Bun.stdin, "text").mockResolvedValueOnce("sk-piped-nontty-789\n")
    try {
      const key = await Effect.runPromise(resolveApiKey(undefined))
      expect(key).toBe("sk-piped-nontty-789")
    } finally {
      stdinSpy.mockRestore()
      Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true })
    }
  })

  test("fails in non-TTY mode when keyArg is not provided and stdin is empty", async () => {
    const originalIsTTY = process.stdin.isTTY
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true })
    const stdinSpy = spyOn(Bun.stdin, "text").mockResolvedValueOnce("")
    try {
      const exit = await Effect.runPromiseExit(resolveApiKey(undefined))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(CliError)
        expect((error as CliError).message).toContain("No API key provided. When running non-interactively")
      }
    } finally {
      stdinSpy.mockRestore()
      Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true })
    }
  })
})

describe("ProvidersLoginCommand builder", () => {
  const getBuilder = () => {
    const builder = ProvidersLoginCommand.builder as (y: Argv) => Argv<any>
    expect(typeof builder).toBe("function")
    return builder
  }

  test("registers key option with aliases api-key and k", () => {
    const parser = getBuilder()(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.key).toBeDefined()
    expect(options.key["api-key"]).toBeDefined()
    expect(options.key.k).toBeDefined()
  })

  test("parses --key flag correctly", () => {
    const parser = getBuilder()(yargs())
    const parsed = parser.parseSync(["--key", "sk-test-abc", "--provider", "openai"])
    expect(parsed.key).toBe("sk-test-abc")
    expect(parsed.provider).toBe("openai")
  })

  test("parses -k and -p aliases correctly", () => {
    const parser = getBuilder()(yargs())
    const parsed = parser.parseSync(["-k", "sk-test-def", "-p", "anthropic"])
    expect(parsed.key).toBe("sk-test-def")
    expect(parsed.provider).toBe("anthropic")
  })
})
