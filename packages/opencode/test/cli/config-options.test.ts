import { describe, expect, test } from "bun:test"
import yargs, { type Argv } from "yargs"
import {
  ConfigGetCommand,
  ConfigListCommand,
  ConfigSetCommand,
  ConfigUnsetCommand,
  ConfigVerifyCommand,
  ConfigPathCommand,
} from "../../src/cli/cmd/config"

describe("config command builders and options", () => {
  test("ConfigGetCommand registers output, o, json, scope, s, project, p, global, and g options", () => {
    const builder = ConfigGetCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
    expect(options.key.scope).toBeDefined()
    expect(options.key.s).toBeDefined()
    expect(options.key.project).toBeDefined()
    expect(options.key.p).toBeDefined()
    expect(options.key.global).toBeDefined()
    expect(options.key.g).toBeDefined()
  })

  test("ConfigListCommand registers output, o, json, scope, s, project, p, global, and g options and ls alias", () => {
    expect(ConfigListCommand.aliases).toContain("ls")
    const builder = ConfigListCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
    expect(options.key.scope).toBeDefined()
    expect(options.key.s).toBeDefined()
    expect(options.key.project).toBeDefined()
    expect(options.key.p).toBeDefined()
    expect(options.key.global).toBeDefined()
    expect(options.key.g).toBeDefined()
  })

  test("ConfigSetCommand registers output, o, json, scope, s, project, p, global, and g options", () => {
    const builder = ConfigSetCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
    expect(options.key.scope).toBeDefined()
    expect(options.key.s).toBeDefined()
    expect(options.key.project).toBeDefined()
    expect(options.key.p).toBeDefined()
    expect(options.key.global).toBeDefined()
    expect(options.key.g).toBeDefined()
  })

  test("ConfigUnsetCommand registers output, o, json, scope, s, project, p, global, and g options", () => {
    const builder = ConfigUnsetCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
    expect(options.key.scope).toBeDefined()
    expect(options.key.s).toBeDefined()
    expect(options.key.project).toBeDefined()
    expect(options.key.p).toBeDefined()
    expect(options.key.global).toBeDefined()
    expect(options.key.g).toBeDefined()
  })

  test("ConfigVerifyCommand registers output, o, and json options", () => {
    const builder = ConfigVerifyCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
  })

  test("ConfigPathCommand registers output, o, json, scope, s, project, p, global, and g options", () => {
    const builder = ConfigPathCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
    expect(options.key.scope).toBeDefined()
    expect(options.key.s).toBeDefined()
    expect(options.key.project).toBeDefined()
    expect(options.key.p).toBeDefined()
    expect(options.key.global).toBeDefined()
    expect(options.key.g).toBeDefined()
  })
})

describe("config option parsing and alias normalization", () => {
  test("ConfigGetCommand parses positional key, -s project, -o, and --json", async () => {
    const parsed = await yargs()
      .command({ ...ConfigGetCommand, handler: () => {} })
      .parseAsync(["get", "model", "-s", "project", "-o", "model.json", "--json"])
    expect(parsed.key).toBe("model")
    expect(parsed.scope).toBe("project")
    expect(parsed.s).toBe("project")
    expect(parsed.output).toBe("model.json")
    expect(parsed.o).toBe("model.json")
    expect(parsed.json).toBe(true)
  })

  test("ConfigGetCommand parses -p and -g flags", async () => {
    const parsedProject = await yargs()
      .command({ ...ConfigGetCommand, handler: () => {} })
      .parseAsync(["get", "model", "-p"])
    expect(parsedProject.project).toBe(true)
    expect(parsedProject.p).toBe(true)

    const parsedGlobal = await yargs()
      .command({ ...ConfigGetCommand, handler: () => {} })
      .parseAsync(["get", "model", "-g"])
    expect(parsedGlobal.global).toBe(true)
    expect(parsedGlobal.g).toBe(true)
  })

  test("ConfigListCommand parses -s global, -o, and --json", async () => {
    const parsed = await yargs()
      .command({ ...ConfigListCommand, handler: () => {} })
      .parseAsync(["list", "-s", "global", "-o", "list.json", "--json"])
    expect(parsed.scope).toBe("global")
    expect(parsed.s).toBe("global")
    expect(parsed.output).toBe("list.json")
    expect(parsed.o).toBe("list.json")
    expect(parsed.json).toBe(true)
  })

  test("ConfigSetCommand parses positional key and value, -s project, and -o", async () => {
    const parsed = await yargs()
      .command({ ...ConfigSetCommand, handler: () => {} })
      .parseAsync(["set", "model", "openai/gpt-5.4", "-s", "project", "-o", "set.txt"])
    expect(parsed.key).toBe("model")
    expect(parsed.value).toBe("openai/gpt-5.4")
    expect(parsed.scope).toBe("project")
    expect(parsed.s).toBe("project")
    expect(parsed.output).toBe("set.txt")
    expect(parsed.o).toBe("set.txt")
  })

  test("ConfigSetCommand parses -p and --json", async () => {
    const parsed = await yargs()
      .command({ ...ConfigSetCommand, handler: () => {} })
      .parseAsync(["set", "compaction", '{"auto":true}', "-p", "--json"])
    expect(parsed.key).toBe("compaction")
    expect(parsed.value).toBe('{"auto":true}')
    expect(parsed.project).toBe(true)
    expect(parsed.p).toBe(true)
    expect(parsed.json).toBe(true)
  })

  test("ConfigUnsetCommand parses positional key, -s global, -o, and --json", async () => {
    const parsed = await yargs()
      .command({ ...ConfigUnsetCommand, handler: () => {} })
      .parseAsync(["unset", "model", "-s", "global", "-o", "unset.json", "--json"])
    expect(parsed.key).toBe("model")
    expect(parsed.scope).toBe("global")
    expect(parsed.s).toBe("global")
    expect(parsed.output).toBe("unset.json")
    expect(parsed.o).toBe("unset.json")
    expect(parsed.json).toBe(true)
  })

  test("ConfigVerifyCommand parses -o and --json", async () => {
    const builder = ConfigVerifyCommand.builder as (y: Argv) => Argv<any>
    const parsed = await builder(yargs()).parseAsync(["-o", "verify.json", "--json"])
    expect(parsed.output).toBe("verify.json")
    expect(parsed.o).toBe("verify.json")
    expect(parsed.json).toBe(true)
  })

  test("ConfigPathCommand parses -s project, -o, and --json", async () => {
    const builder = ConfigPathCommand.builder as (y: Argv) => Argv<any>
    const parsed = await builder(yargs()).parseAsync([
      "-s",
      "project",
      "-o",
      "paths.json",
      "--json",
    ])
    expect(parsed.scope).toBe("project")
    expect(parsed.s).toBe("project")
    expect(parsed.output).toBe("paths.json")
    expect(parsed.o).toBe("paths.json")
    expect(parsed.json).toBe(true)
  })

  test("addScopeOptions rejects mutually exclusive scope combinations with short aliases", async () => {
    const builder = ConfigPathCommand.builder as (y: Argv) => Argv<any>
    let caughtProjectGlobal = false
    try {
      await builder(yargs()).fail(false).parseAsync(["-p", "-g"])
    } catch {
      caughtProjectGlobal = true
    }
    expect(caughtProjectGlobal).toBe(true)

    let caughtScopeProject = false
    try {
      await builder(yargs()).fail(false).parseAsync(["-s", "project", "-p"])
    } catch {
      caughtScopeProject = true
    }
    expect(caughtScopeProject).toBe(true)

    let caughtScopeGlobal = false
    try {
      await builder(yargs()).fail(false).parseAsync(["-s", "global", "-g"])
    } catch {
      caughtScopeGlobal = true
    }
    expect(caughtScopeGlobal).toBe(true)
  })
})
