import { test, expect, describe } from "bun:test"
import yargs, { type Argv } from "yargs"
import { ImportCommand, formatImportFileError } from "../../src/cli/cmd/import"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { PlatformError } from "effect"

test("formats import file errors", () => {
  expect(
    formatImportFileError(
      "test.json",
      new PlatformError.PlatformError(
        new PlatformError.SystemError({
          _tag: "NotFound",
          module: "FileSystem",
          method: "readFileString",
        }),
      ),
    ),
  ).toBe("File not found: test.json")
  expect(
    formatImportFileError(
      "test.json",
      new PlatformError.PlatformError(
        new PlatformError.SystemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "readFileString",
        }),
      ),
    ),
  ).toBe("Failed to read file: Permission denied")
  expect(
    formatImportFileError(
      "test.json",
      new FSUtil.FileSystemError({ method: "readJson", cause: new SyntaxError("Unexpected token") }),
    ),
  ).toBe("Invalid JSON in test.json: Unexpected token")
})

describe("ImportCommand builder & option parsing", () => {
  test("ImportCommand registers file positional and title, output, json options with aliases", () => {
    expect(ImportCommand.command).toBe("import <file>")
    const builder = ImportCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.file).toBeDefined()
    expect(options.key.title).toBeDefined()
    expect(options.key.t).toBeDefined()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
  })

  test("ImportCommand parses short aliases -t and -o", async () => {
    const parsed = await yargs()
      .command({ ...ImportCommand, handler: () => {} })
      .parseAsync(["import", "session.json", "-t", "Custom Title", "-o", "result.json", "--json"])
    expect(parsed.file).toBe("session.json")
    expect(parsed.title).toBe("Custom Title")
    expect(parsed.t).toBe("Custom Title")
    expect(parsed.output).toBe("result.json")
    expect(parsed.o).toBe("result.json")
    expect(parsed.json).toBe(true)
  })

  test("ImportCommand parses long options correctly", async () => {
    const parsed = await yargs()
      .command({ ...ImportCommand, handler: () => {} })
      .parseAsync(["import", "session.json", "--title", "Long Title", "--output", "out.txt"])
    expect(parsed.file).toBe("session.json")
    expect(parsed.title).toBe("Long Title")
    expect(parsed.output).toBe("out.txt")
  })
})
