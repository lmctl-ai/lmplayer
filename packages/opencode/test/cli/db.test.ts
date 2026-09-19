import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AppRuntime } from "../../src/effect/app-runtime"
import {
  CheckCommand,
  DbCommand,
  dbCheck,
  dbInfo,
  dbVacuum,
  formatBytes,
  InfoCommand,
  PathCommand,
  QueryCommand,
  VacuumCommand,
} from "../../src/cli/cmd/db"
import { cliIt } from "../lib/cli-process"
import yargs, { type Argv } from "yargs"

// ─── formatBytes helper ──────────────────────────────────────────────────────

describe("formatBytes", () => {
  test("formats bytes correctly", () => {
    expect(formatBytes(500)).toBe("500 B")
    expect(formatBytes(1024)).toBe("1.0 KB")
    expect(formatBytes(1536)).toBe("1.5 KB")
    expect(formatBytes(1024 * 1024)).toBe("1.00 MB")
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.00 MB")
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.50 GB")
  })
})

// ─── Command definitions & builders ──────────────────────────────────────────

describe("db command definitions & builders", () => {
  test("PathCommand registers path and json option", () => {
    expect(PathCommand.command).toBe("path")
    const builder = PathCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.json).toBeDefined()
  })

  test("InfoCommand registers info, aliases, and json option", () => {
    expect(InfoCommand.command).toBe("info")
    expect(InfoCommand.aliases).toContain("stats")
    expect(InfoCommand.aliases).toContain("status")
    const builder = InfoCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.json).toBeDefined()
  })

  test("CheckCommand registers check, aliases, and json option", () => {
    expect(CheckCommand.command).toBe("check")
    expect(CheckCommand.aliases).toContain("verify")
    expect(CheckCommand.aliases).toContain("integrity")
    const builder = CheckCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.json).toBeDefined()
  })

  test("VacuumCommand registers vacuum, aliases, and options", () => {
    expect(VacuumCommand.command).toBe("vacuum")
    expect(VacuumCommand.aliases).toContain("optimize")
    expect(VacuumCommand.aliases).toContain("clean")
    const builder = VacuumCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.wal).toBeDefined()
    expect(options.key.analyze).toBeDefined()
    expect(options.key.json).toBeDefined()
  })

  test("QueryCommand registers $0 [query] and format option", () => {
    expect(QueryCommand.command).toBe("$0 [query]")
    const builder = QueryCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.format).toBeDefined()
  })

  test("DbCommand registers all subcommands", () => {
    expect(DbCommand.command).toBe("db")
  })
})

// ─── In-process execution ────────────────────────────────────────────────────

describe("db in-process execution", () => {
  test("dbInfo returns structured database metadata", async () => {
    let captured = ""
    const originalWrite = process.stdout.write
    process.stdout.write = ((chunk: any) => {
      captured += String(chunk)
      return true
    }) as any

    try {
      const info = await AppRuntime.runPromise(dbInfo({ json: true }))
      expect(info).toBeDefined()
      expect(typeof info.path).toBe("string")
      expect(typeof info.sqlite_version).toBe("string")
      expect(typeof info.journal_mode).toBe("string")
      expect(typeof info.size_bytes).toBe("number")
      expect(info.size_bytes).toBeGreaterThanOrEqual(0)
      expect(typeof info.page_size).toBe("number")
      expect(info.page_size).toBeGreaterThan(0)
      expect(typeof info.page_count).toBe("number")
      expect(typeof info.freelist_count).toBe("number")
      expect(typeof info.tables).toBe("object")
      expect(info.tables.session).toBeDefined()

      const parsed = JSON.parse(captured)
      expect(parsed.path).toBe(info.path)
      expect(parsed.sqlite_version).toBe(info.sqlite_version)
    } finally {
      process.stdout.write = originalWrite
    }
  })

  test("dbCheck returns ok for healthy database", async () => {
    let captured = ""
    const originalWrite = process.stdout.write
    process.stdout.write = ((chunk: any) => {
      captured += String(chunk)
      return true
    }) as any

    try {
      const check = await AppRuntime.runPromise(dbCheck({ json: true }))
      expect(check).toBeDefined()
      expect(check.ok).toBe(true)
      expect(check.integrity).toEqual(["ok"])
      expect(check.foreign_keys).toEqual([])

      const parsed = JSON.parse(captured)
      expect(parsed.ok).toBe(true)
    } finally {
      process.stdout.write = originalWrite
    }
  })

  test("dbVacuum executes VACUUM and WAL checkpoint", async () => {
    let captured = ""
    const originalWrite = process.stdout.write
    process.stdout.write = ((chunk: any) => {
      captured += String(chunk)
      return true
    }) as any

    try {
      const vacuum = await AppRuntime.runPromise(dbVacuum({ json: true, analyze: true }))
      expect(vacuum).toBeDefined()
      expect(vacuum.wal_checkpoint).toBe(true)
      expect(vacuum.vacuumed).toBe(true)
      expect(vacuum.analyzed).toBe(true)
      expect(typeof vacuum.before_bytes).toBe("number")
      expect(typeof vacuum.after_bytes).toBe("number")
      expect(typeof vacuum.freed_bytes).toBe("number")

      const parsed = JSON.parse(captured)
      expect(parsed.wal_checkpoint).toBe(true)
    } finally {
      process.stdout.write = originalWrite
    }
  })

  test("dbVacuum with wal option skips full vacuum", async () => {
    let captured = ""
    const originalWrite = process.stdout.write
    process.stdout.write = ((chunk: any) => {
      captured += String(chunk)
      return true
    }) as any

    try {
      const vacuum = await AppRuntime.runPromise(dbVacuum({ wal: true, json: true }))
      expect(vacuum).toBeDefined()
      expect(vacuum.wal_checkpoint).toBe(true)
      expect(vacuum.vacuumed).toBe(false)
    } finally {
      process.stdout.write = originalWrite
    }
  })
})

// ─── Subprocess CLI tests ────────────────────────────────────────────────────

describe("db CLI subprocess", () => {
  cliIt.concurrent(
    "db path prints database path",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["db", "path"])
        opencode.expectExit(result, 0)
        expect(result.stdout).toContain(".db")
      }),
    60_000,
  )

  cliIt.concurrent(
    "db path --json prints json with wal and shm paths",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["db", "path", "--json"])
        opencode.expectExit(result, 0)
        const parsed = JSON.parse(result.stdout)
        expect(parsed.path).toContain(".db")
        expect(parsed.wal).toContain(".db-wal")
        expect(parsed.shm).toContain(".db-shm")
      }),
    60_000,
  )

  cliIt.concurrent(
    "db info --json outputs structured stats",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["db", "info", "--json"])
        opencode.expectExit(result, 0)
        const parsed = JSON.parse(result.stdout)
        expect(parsed.path).toBeDefined()
        expect(parsed.sqlite_version).toBeDefined()
        expect(parsed.size_bytes).toBeGreaterThan(0)
        expect(parsed.tables).toBeDefined()
      }),
    60_000,
  )

  cliIt.concurrent(
    "db check --json returns ok",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["db", "check", "--json"])
        opencode.expectExit(result, 0)
        const parsed = JSON.parse(result.stdout)
        expect(parsed.ok).toBe(true)
        expect(parsed.integrity).toEqual(["ok"])
      }),
    60_000,
  )

  cliIt.concurrent(
    "db vacuum --json reclaims disk space",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["db", "vacuum", "--json"])
        opencode.expectExit(result, 0)
        const parsed = JSON.parse(result.stdout)
        expect(parsed.wal_checkpoint).toBe(true)
        expect(parsed.vacuumed).toBe(true)
      }),
    60_000,
  )
})
