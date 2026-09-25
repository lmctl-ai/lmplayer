import type { Argv } from "yargs"
import { spawn } from "child_process"
import { Database } from "@opencode-ai/core/database/database"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { effectCmd } from "../effect-cmd"
import { EOL } from "os"
import fs from "fs"
import path from "path"
import { UI } from "../ui"
import * as Prompt from "../effect/prompt"

function* writeOutputFile(filePath: string, content: string, label: string) {
  const resolved = path.resolve(filePath)
  yield* Effect.promise(async () => {
    await fs.promises.mkdir(path.dirname(resolved), { recursive: true })
    await fs.promises.writeFile(resolved, content, "utf-8")
  })
  UI.println(`Wrote ${label} to ${resolved}`)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function getFileSize(p: string): number {
  try {
    return fs.statSync(p).size
  } catch {
    return 0
  }
}

export type DbPathJson = {
  path: string
  wal: string
  shm: string
}

export type DbPathArgs = {
  json?: boolean
  output?: string
  o?: string
}

export const PathCommand = effectCmd({
  command: "path",
  describe: "print the database path",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write database path to output file path",
      })
      .option("json", {
        type: "boolean",
        describe: "output as JSON",
      }),
  handler: Effect.fn("Cli.db.path")(function* (args: DbPathArgs) {
    const dbPath = Database.path()
    const output = args.output || args.o
    if (args.json) {
      const result: DbPathJson = {
        path: dbPath,
        wal: `${dbPath}-wal`,
        shm: `${dbPath}-shm`,
      }
      const jsonStr = JSON.stringify(result, null, 2) + EOL
      if (output) {
        yield* writeOutputFile(output, jsonStr, "database path")
        return
      }
      process.stdout.write(jsonStr)
      return
    }
    if (output) {
      yield* writeOutputFile(output, dbPath + EOL, "database path")
      return
    }
    console.log(dbPath)
  }),
})

export type DbInfoJson = {
  path: string
  wal_path: string
  shm_path: string
  size_bytes: number
  size_formatted: string
  wal_bytes: number
  wal_formatted: string
  shm_bytes: number
  shm_formatted: string
  total_bytes: number
  total_formatted: string
  sqlite_version: string
  journal_mode: string
  page_size: number
  page_count: number
  freelist_count: number
  tables: Record<string, number>
}

export type DbInfoArgs = {
  json?: boolean
  output?: string
  o?: string
}

export const dbInfo = Effect.fn("Cli.db.info.fn")(function* (args?: DbInfoArgs) {
  const { db } = yield* Database.Service
  const dbPath = Database.path()
  const walPath = `${dbPath}-wal`
  const shmPath = `${dbPath}-shm`
  const output = args?.output || args?.o

  const dbSize = getFileSize(dbPath)
  const walSize = getFileSize(walPath)
  const shmSize = getFileSize(shmPath)
  const totalSize = dbSize + walSize + shmSize

  const versionResult = yield* db
    .all<{ version: string }>(sql.raw("SELECT sqlite_version() as version"))
    .pipe(Effect.orDie)
  const sqliteVersion = versionResult[0]?.version ?? "unknown"

  const pragmaResult = yield* db
    .all<{ page_count: number; page_size: number; freelist_count: number }>(
      sql.raw(
        "SELECT page_count, page_size, freelist_count FROM pragma_page_count(), pragma_page_size(), pragma_freelist_count()",
      ),
    )
    .pipe(Effect.orDie)
  const pageSize = pragmaResult[0]?.page_size ?? 0
  const pageCount = pragmaResult[0]?.page_count ?? 0
  const freelistCount = pragmaResult[0]?.freelist_count ?? 0

  const journalResult = yield* db
    .all<{ journal_mode: string }>(sql.raw("PRAGMA journal_mode"))
    .pipe(Effect.orDie)
  const journalMode = journalResult[0]?.journal_mode ?? "unknown"

  const tablesResult = yield* db
    .all<{ name: string }>(
      sql.raw(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name",
      ),
    )
    .pipe(Effect.orDie)

  const tables: Record<string, number> = {}
  for (const { name } of tablesResult) {
    try {
      const countResult = yield* db
        .all<{ count: number }>(sql.raw(`SELECT count(*) as count FROM "${name}"`))
        .pipe(Effect.orDie)
      tables[name] = countResult[0]?.count ?? 0
    } catch {
      // Ignore unqueryable virtual tables or views
    }
  }

  const info: DbInfoJson = {
    path: dbPath,
    wal_path: walPath,
    shm_path: shmPath,
    size_bytes: dbSize,
    size_formatted: formatBytes(dbSize),
    wal_bytes: walSize,
    wal_formatted: formatBytes(walSize),
    shm_bytes: shmSize,
    shm_formatted: formatBytes(shmSize),
    total_bytes: totalSize,
    total_formatted: formatBytes(totalSize),
    sqlite_version: sqliteVersion,
    journal_mode: journalMode,
    page_size: pageSize,
    page_count: pageCount,
    freelist_count: freelistCount,
    tables,
  }

  if (args?.json) {
    const jsonStr = JSON.stringify(info, null, 2) + EOL
    if (output) {
      yield* writeOutputFile(output, jsonStr, "database info")
      return info
    }
    process.stdout.write(jsonStr)
    return info
  }

  const tableEntries = Object.entries(tables).filter(([_, count]) => count > 0)
  if (output) {
    const lines = [
      `Database: ${dbPath}`,
      `SQLite Version: ${sqliteVersion} (journal: ${journalMode})`,
      `Size: ${info.size_formatted} (WAL: ${info.wal_formatted}, SHM: ${info.shm_formatted}, Total: ${info.total_formatted})`,
      `Pages: ${pageCount.toLocaleString()} pages @ ${pageSize} bytes (freelist: ${freelistCount})`,
      "",
      "Tables:",
      ...(tableEntries.length > 0
        ? tableEntries.map(([table, count]) => `  ${table}: ${count.toLocaleString()} rows`)
        : ["  (all empty)"]),
    ]
    yield* writeOutputFile(output, lines.join(EOL) + EOL, "database info")
    return info
  }

  UI.empty()
  yield* Prompt.intro(`Database Info ${UI.Style.TEXT_DIM}${dbPath}`)
  yield* Prompt.log.info(`SQLite Version: ${sqliteVersion} (journal: ${journalMode})`)
  yield* Prompt.log.info(
    `Size: ${info.size_formatted} (WAL: ${info.wal_formatted}, SHM: ${info.shm_formatted}, Total: ${info.total_formatted})`,
  )
  yield* Prompt.log.info(`Pages: ${pageCount.toLocaleString()} pages @ ${pageSize} bytes (freelist: ${freelistCount})`)

  if (tableEntries.length > 0) {
    yield* Prompt.log.info("Tables:")
    for (const [table, count] of tableEntries) {
      yield* Prompt.log.info(`  ${table}: ${count.toLocaleString()} rows`)
    }
  } else {
    yield* Prompt.log.info("Tables: (all empty)")
  }

  yield* Prompt.outro("Done")
  return info
})

export const InfoCommand = effectCmd({
  command: "info",
  aliases: ["stats", "status"],
  describe: "show database size, row counts, and storage metrics",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write database info to output file path",
      })
      .option("json", {
        type: "boolean",
        describe: "output as JSON",
      }),
  handler: Effect.fn("Cli.db.info")(function* (args: DbInfoArgs) {
    yield* dbInfo(args)
  }),
})

export type DbCheckJson = {
  ok: boolean
  path: string
  integrity: string[]
  foreign_keys: Array<Record<string, unknown>>
}

export type DbCheckArgs = {
  json?: boolean
  output?: string
  o?: string
}

export const dbCheck = Effect.fn("Cli.db.check.fn")(function* (args?: DbCheckArgs) {
  const { db } = yield* Database.Service
  const dbPath = Database.path()
  const output = args?.output || args?.o

  const integrityRows = yield* db
    .all<{ integrity_check: string }>(sql.raw("PRAGMA integrity_check"))
    .pipe(Effect.orDie)
  const integrity = integrityRows.map((r) => r.integrity_check)

  const fkRows = yield* db
    .all<Record<string, unknown>>(sql.raw("PRAGMA foreign_key_check"))
    .pipe(Effect.orDie)

  const isOk = integrity.length === 1 && integrity[0] === "ok" && fkRows.length === 0

  const result: DbCheckJson = {
    ok: isOk,
    path: dbPath,
    integrity,
    foreign_keys: fkRows,
  }

  if (args?.json) {
    const jsonStr = JSON.stringify(result, null, 2) + EOL
    if (output) {
      yield* writeOutputFile(output, jsonStr, "database check results")
      if (!isOk) {
        process.exitCode = 1
      }
      return result
    }
    process.stdout.write(jsonStr)
    if (!isOk) {
      process.exitCode = 1
    }
    return result
  }

  if (output) {
    const lines = [
      `Database: ${dbPath}`,
      `Status: ${isOk ? "OK" : "FAILED"}`,
      `Integrity: ${integrity.join(", ")}`,
      `Foreign Key Violations: ${fkRows.length}`,
      ...(fkRows.length > 0 ? fkRows.map((r) => `  ${JSON.stringify(r)}`) : []),
    ]
    yield* writeOutputFile(output, lines.join(EOL) + EOL, "database check results")
    if (!isOk) {
      process.exitCode = 1
    }
    return result
  }

  UI.empty()
  yield* Prompt.intro(`Database Integrity Check ${UI.Style.TEXT_DIM}${dbPath}`)
  if (isOk) {
    yield* Prompt.log.success("Database integrity and foreign key constraints: OK")
    yield* Prompt.outro("Done")
  } else {
    yield* Prompt.log.error("Database integrity issues detected:")
    if (integrity.length > 1 || integrity[0] !== "ok") {
      for (const err of integrity) {
        yield* Prompt.log.error(`  integrity error: ${err}`)
      }
    }
    if (fkRows.length > 0) {
      yield* Prompt.log.error(`  foreign key violations: ${fkRows.length}`)
      for (const row of fkRows) {
        yield* Prompt.log.error(`    ${JSON.stringify(row)}`)
      }
    }
    yield* Prompt.outro("Integrity check failed")
    process.exitCode = 1
  }

  return result
})

export const CheckCommand = effectCmd({
  command: "check",
  aliases: ["verify", "integrity"],
  describe: "verify database integrity and foreign key constraints",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write check results to output file path",
      })
      .option("json", {
        type: "boolean",
        describe: "output as JSON",
      }),
  handler: Effect.fn("Cli.db.check")(function* (args: DbCheckArgs) {
    yield* dbCheck(args)
  }),
})

export type DbVacuumJson = {
  path: string
  before_bytes: number
  after_bytes: number
  freed_bytes: number
  wal_checkpoint: boolean
  vacuumed: boolean
  analyzed: boolean
}

export type DbVacuumArgs = {
  wal?: boolean
  checkpoint?: boolean
  analyze?: boolean
  json?: boolean
  output?: string
  o?: string
}

export const dbVacuum = Effect.fn("Cli.db.vacuum.fn")(function* (args?: DbVacuumArgs) {
  const { db } = yield* Database.Service
  const dbPath = Database.path()
  const output = args?.output || args?.o
  const walOnly = Boolean(args?.wal || args?.checkpoint)
  const doAnalyze = Boolean(args?.analyze)

  const beforeDb = getFileSize(dbPath)
  const beforeWal = getFileSize(`${dbPath}-wal`)
  const beforeTotal = beforeDb + beforeWal

  if (!walOnly) {
    yield* db.run("VACUUM").pipe(Effect.orDie)
  }

  yield* db.run("PRAGMA wal_checkpoint(TRUNCATE)").pipe(Effect.orDie)

  if (doAnalyze) {
    yield* db.run("ANALYZE").pipe(Effect.orDie)
  }

  yield* db.run("PRAGMA optimize").pipe(Effect.orDie)

  const afterDb = getFileSize(dbPath)
  const afterWal = getFileSize(`${dbPath}-wal`)
  const afterTotal = afterDb + afterWal
  const freedBytes = Math.max(0, beforeTotal - afterTotal)

  const result: DbVacuumJson = {
    path: dbPath,
    before_bytes: beforeTotal,
    after_bytes: afterTotal,
    freed_bytes: freedBytes,
    wal_checkpoint: true,
    vacuumed: !walOnly,
    analyzed: doAnalyze,
  }

  if (args?.json) {
    const jsonStr = JSON.stringify(result, null, 2) + EOL
    if (output) {
      yield* writeOutputFile(output, jsonStr, "vacuum results")
      return result
    }
    process.stdout.write(jsonStr)
    return result
  }

  if (output) {
    const lines = [
      `Database: ${dbPath}`,
      `Operation: ${walOnly ? "WAL checkpoint (TRUNCATE)" : "VACUUM and WAL checkpoint (TRUNCATE)"}`,
      `Analyze: ${doAnalyze ? "yes" : "no"}`,
      `Before Size: ${formatBytes(beforeTotal)}`,
      `After Size: ${formatBytes(afterTotal)}`,
      `Freed: ${formatBytes(freedBytes)}`,
    ]
    yield* writeOutputFile(output, lines.join(EOL) + EOL, "vacuum results")
    return result
  }

  UI.empty()
  yield* Prompt.intro(`Database Maintenance ${UI.Style.TEXT_DIM}${dbPath}`)
  if (walOnly) {
    yield* Prompt.log.info("WAL checkpoint (TRUNCATE) executed")
  } else {
    yield* Prompt.log.info("VACUUM and WAL checkpoint (TRUNCATE) executed")
  }
  if (doAnalyze) {
    yield* Prompt.log.info("Query planner statistics analyzed (ANALYZE)")
  }
  yield* Prompt.log.info("PRAGMA optimize executed")

  if (freedBytes > 0) {
    yield* Prompt.log.success(`Freed ${formatBytes(freedBytes)} (size: ${formatBytes(afterTotal)})`)
  } else {
    yield* Prompt.log.info(`Database already compact (size: ${formatBytes(afterTotal)})`)
  }

  yield* Prompt.outro("Done")
  return result
})

export const VacuumCommand = effectCmd({
  command: "vacuum",
  aliases: ["optimize", "clean"],
  describe: "reclaim disk space, checkpoint WAL, and optimize",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .option("wal", {
        alias: ["checkpoint"],
        type: "boolean",
        describe: "only checkpoint and truncate the WAL without rewriting the database file",
      })
      .option("analyze", {
        type: "boolean",
        describe: "run ANALYZE for query planner statistics",
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write vacuum results to output file path",
      })
      .option("json", {
        type: "boolean",
        describe: "output as JSON",
      }),
  handler: Effect.fn("Cli.db.vacuum")(function* (args: DbVacuumArgs) {
    yield* dbVacuum(args)
  }),
})

export type DbQueryArgs = {
  query?: string
  format?: string
  json?: boolean
  output?: string
  o?: string
}

export const QueryCommand = effectCmd({
  command: "$0 [query]",
  describe: "open an interactive sqlite3 shell or run a query",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs
      .positional("query", {
        type: "string",
        describe: "SQL query to execute",
      })
      .option("format", {
        type: "string",
        choices: ["json", "tsv"],
        default: "tsv",
        describe: "Output format",
      })
      .option("json", {
        type: "boolean",
        describe: "output results as JSON (equivalent to --format json)",
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write query results to output file path",
      })
  },
  handler: Effect.fn("Cli.db.query")(function* (args: DbQueryArgs) {
    const query = args.query as string | undefined
    if (query) {
      const { db } = yield* Database.Service
      const result = yield* db.all<Record<string, unknown>>(sql.raw(query)).pipe(Effect.orDie)
      const isJson = Boolean(args.json || args.format === "json")
      let content = ""
      if (isJson) {
        content = JSON.stringify(result, null, 2)
      } else if (result.length > 0) {
        const keys = Object.keys(result[0])
        const lines = [keys.join("\t")]
        for (const row of result) lines.push(keys.map((key) => String(row[key] ?? "")).join("\t"))
        content = lines.join("\n")
      }
      const output = args.output || args.o
      if (output) {
        yield* writeOutputFile(output, content + "\n", "query results")
      }
      if (isJson) {
        console.log(content)
      } else if (!output && content) {
        console.log(content)
      }
      return
    }
    const child = spawn("sqlite3", [Database.path()], {
      stdio: "inherit",
    })
    yield* Effect.promise(() => new Promise((resolve) => child.on("close", resolve)))
  }),
})

export const DbCommand = effectCmd({
  command: "db",
  describe: "database tools",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs
      .command(QueryCommand)
      .command(PathCommand)
      .command(InfoCommand)
      .command(CheckCommand)
      .command(VacuumCommand)
      .demandCommand()
  },
  handler: Effect.fn("Cli.db")(function* () {}),
})
