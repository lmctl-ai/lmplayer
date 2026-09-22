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
  test("ConfigGetCommand registers output, o, and json options", () => {
    const builder = ConfigGetCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
    expect(options.key.scope).toBeDefined()
    expect(options.key.project).toBeDefined()
    expect(options.key.global).toBeDefined()
  })

  test("ConfigListCommand registers output, o, and json options", () => {
    const builder = ConfigListCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
    expect(options.key.scope).toBeDefined()
    expect(options.key.project).toBeDefined()
    expect(options.key.global).toBeDefined()
  })

  test("ConfigSetCommand registers output, o, and json options", () => {
    const builder = ConfigSetCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
    expect(options.key.scope).toBeDefined()
    expect(options.key.project).toBeDefined()
    expect(options.key.global).toBeDefined()
  })

  test("ConfigUnsetCommand registers output, o, and json options", () => {
    const builder = ConfigUnsetCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
    expect(options.key.scope).toBeDefined()
    expect(options.key.project).toBeDefined()
    expect(options.key.global).toBeDefined()
  })

  test("ConfigVerifyCommand registers output, o, and json options", () => {
    const builder = ConfigVerifyCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
  })

  test("ConfigPathCommand registers output, o, and json options", () => {
    const builder = ConfigPathCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
    expect(options.key.scope).toBeDefined()
    expect(options.key.project).toBeDefined()
    expect(options.key.global).toBeDefined()
  })
})
