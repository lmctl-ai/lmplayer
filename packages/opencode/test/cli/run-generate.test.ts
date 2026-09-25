import { describe, expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import fs from "node:fs/promises"
import yargs, { type Argv } from "yargs"
import {
  RunCommand,
  formatRunOutputText,
  writeRunOutputFile,
} from "../../src/cli/cmd/run"
import { GenerateCommand } from "../../src/cli/cmd/generate"

describe("RunCommand builder and output options", () => {
  test("RunCommand registers output, format, and json options", () => {
    const builder = RunCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.format).toBeDefined()
    expect(options.key.json).toBeDefined()
    expect(options.key.message).toBeDefined()
    expect(options.key.model).toBeDefined()
    expect(options.key.agent).toBeDefined()
  })

  test("RunCommand parses output and json options from arguments", async () => {
    const builder = RunCommand.builder as (y: Argv) => Argv<any>
    const parsed = await builder(yargs()).parseAsync([
      "--output",
      "result.json",
      "--json",
    ])
    expect(parsed.output).toBe("result.json")
    expect(parsed.json).toBe(true)
  })

  test("RunCommand parses positional message, output, and json when registered as command", async () => {
    const parsed = await yargs()
      .command({
        ...RunCommand,
        handler: () => {},
      })
      .parseAsync([
        "run",
        "hello world",
        "--output",
        "result.json",
        "--json",
      ])
    expect(parsed.message).toEqual(["hello world"])
    expect(parsed.output).toBe("result.json")
    expect(parsed.json).toBe(true)
  })

  test("RunCommand parses -o short alias", async () => {
    const builder = RunCommand.builder as (y: Argv) => Argv<any>
    const parsed = await builder(yargs()).parseAsync(["-o", "result.txt"])
    expect(parsed.output).toBe("result.txt")
  })
})

describe("GenerateCommand builder and options", () => {
  test("GenerateCommand registers output, json, and describe", () => {
    expect(GenerateCommand.describe).toBe("generate OpenAPI schema")
    const builder = GenerateCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
  })

  test("GenerateCommand parses -o short alias and --json", async () => {
    const builder = GenerateCommand.builder as (y: Argv) => Argv<any>
    const parsed = await builder(yargs()).parseAsync(["-o", "schema.json", "--json"])
    expect(parsed.output).toBe("schema.json")
    expect(parsed.o).toBe("schema.json")
    expect(parsed.json).toBe(true)
  })
})

describe("formatRunOutputText", () => {
  test("joins multiple text parts with double newlines", () => {
    const text = formatRunOutputText(["Part 1: intro", "Part 2: body", "Part 3: conclusion"])
    expect(text).toContain("Part 1: intro")
    expect(text).toContain("Part 2: body")
    expect(text).toContain("Part 3: conclusion")
    expect(text).toMatch(/Part 1: intro\r?\n\r?\nPart 2: body\r?\n\r?\nPart 3: conclusion/)
  })

  test("handles empty and single parts", () => {
    expect(formatRunOutputText([])).toBe("")
    expect(formatRunOutputText(["Single part"])).toBe("Single part")
  })
})

describe("writeRunOutputFile", () => {
  test("writes text content to file", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "run-output-test-"))
    try {
      const textFile = path.join(tempDir, "response.txt")
      await writeRunOutputFile(textFile, {
        sessionID: "ses_123",
        textParts: ["First answer line", "Second answer line"],
      })

      const content = await fs.readFile(textFile, "utf-8")
      expect(content).toContain("First answer line")
      expect(content).toContain("Second answer line")
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  test("writes structured json when file ends in .json", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "run-output-test-"))
    try {
      const jsonFile = path.join(tempDir, "response.json")
      await writeRunOutputFile(jsonFile, {
        sessionID: "ses_456",
        textParts: ["Hello from model"],
      })

      const content = await fs.readFile(jsonFile, "utf-8")
      const parsed = JSON.parse(content)
      expect(parsed.sessionID).toBe("ses_456")
      expect(parsed.text).toBe("Hello from model")
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  test("writes events array when format is json and events are provided", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "run-output-test-"))
    try {
      const jsonFile = path.join(tempDir, "events.json")
      const events = [
        { type: "text", timestamp: 1000, sessionID: "ses_789", part: { text: "Hello" } },
        { type: "step_finish", timestamp: 1001, sessionID: "ses_789" },
      ]
      await writeRunOutputFile(jsonFile, {
        format: "json",
        sessionID: "ses_789",
        events,
      })

      const content = await fs.readFile(jsonFile, "utf-8")
      const parsed = JSON.parse(content)
      expect(Array.isArray(parsed)).toBe(true)
      expect(parsed.length).toBe(2)
      expect(parsed[0].type).toBe("text")
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })
})
