import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { SessionMemoryCommand, sessionMemory } from "../../src/cli/cmd/session"
import { Session } from "../../src/session/session"
import { InstanceRef } from "../../src/effect/instance-ref"
import { InstanceRuntime } from "../../src/project/instance-runtime"
import { AppRuntime } from "../../src/effect/app-runtime"
import { tmpdir } from "../fixture/fixture"
import yargs, { type Argv } from "yargs"
import fs from "fs/promises"
import path from "path"

describe("SessionMemoryCommand options and builder", () => {
  test("SessionMemoryCommand registers sessionID, json, write (-w), append (-a), file (-f), clear (-c), output (-o), and aliases brain", () => {
    expect(SessionMemoryCommand.aliases).toContain("brain")
    const builder = SessionMemoryCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
    expect(options.key.write).toBeDefined()
    expect(options.key.w).toBeDefined()
    expect(options.key.append).toBeDefined()
    expect(options.key.a).toBeDefined()
    expect(options.key.file).toBeDefined()
    expect(options.key.f).toBeDefined()
    expect(options.key.clear).toBeDefined()
    expect(options.key.c).toBeDefined()
  })

  test("SessionMemoryCommand parses positionals and -w, -o, --json flags", async () => {
    const parsed = await yargs()
      .command({ ...SessionMemoryCommand, handler: () => {} })
      .parseAsync(["memory", "ses_mem_1", "-w", "# Heading", "-o", "mem.md", "--json"])
    expect(parsed.sessionID).toBe("ses_mem_1")
    expect(parsed.write).toBe("# Heading")
    expect(parsed.w).toBe("# Heading")
    expect(parsed.output).toBe("mem.md")
    expect(parsed.o).toBe("mem.md")
    expect(parsed.json).toBe(true)
  })

  test("SessionMemoryCommand parses positionals and -a, -f, -c flags", async () => {
    const parsedAppend = await yargs()
      .command({ ...SessionMemoryCommand, handler: () => {} })
      .parseAsync(["memory", "ses_mem_2", "-a", "extra notes"])
    expect(parsedAppend.sessionID).toBe("ses_mem_2")
    expect(parsedAppend.append).toBe("extra notes")
    expect(parsedAppend.a).toBe("extra notes")

    const parsedFile = await yargs()
      .command({ ...SessionMemoryCommand, handler: () => {} })
      .parseAsync(["memory", "ses_mem_3", "-f", "notes.md"])
    expect(parsedFile.sessionID).toBe("ses_mem_3")
    expect(parsedFile.file).toBe("notes.md")
    expect(parsedFile.f).toBe("notes.md")

    const parsedClear = await yargs()
      .command({ ...SessionMemoryCommand, handler: () => {} })
      .parseAsync(["memory", "ses_mem_4", "-c", "-o", "cleared.json", "--json"])
    expect(parsedClear.sessionID).toBe("ses_mem_4")
    expect(parsedClear.clear).toBe(true)
    expect(parsedClear.c).toBe(true)
    expect(parsedClear.output).toBe("cleared.json")
    expect(parsedClear.o).toBe("cleared.json")
    expect(parsedClear.json).toBe(true)
  })
})

describe("SessionMemoryCommand handler", () => {
  const runMemory = (args: any, ctx: any) =>
    AppRuntime.runPromise(sessionMemory(args).pipe(Effect.provideService(InstanceRef, ctx)))

  const runMemoryExit = (args: any, ctx: any) =>
    AppRuntime.runPromiseExit(sessionMemory(args).pipe(Effect.provideService(InstanceRef, ctx)))

  test("fails cleanly for non-existent session", async () => {
    const tmp = await tmpdir({ git: true })
    const ctx = await InstanceRuntime.load({ directory: tmp.path })
    try {
      const exit = await runMemoryExit({ sessionID: "ses_nonexistent123" }, ctx)
      expect(Exit.isFailure(exit)).toBe(true)
    } finally {
      await InstanceRuntime.disposeInstance(ctx)
    }
  })

  test("reads, writes, appends, and clears durable memory for a session", async () => {
    const tmp = await tmpdir({ git: true })
    const ctx = await InstanceRuntime.load({ directory: tmp.path })

    try {
      // 1. Create real session in database
      const session = await AppRuntime.runPromise(
        Session.Service.use((svc) => svc.create({})).pipe(Effect.provideService(InstanceRef, ctx)),
      )
      const sessionID = session.id

      // 2. Read empty memory as JSON
      let captured = ""
      const originalWrite = process.stdout.write
      process.stdout.write = ((chunk: any) => {
        captured += String(chunk)
        return true
      }) as any

      try {
        await runMemory({ sessionID, json: true }, ctx)
      } finally {
        process.stdout.write = originalWrite
      }

      const emptyData = JSON.parse(captured)
      expect(emptyData.sessionID).toBe(sessionID)
      expect(emptyData.exists).toBe(false)
      expect(emptyData.content).toBe("")

      // 3. Write memory via write
      captured = ""
      process.stdout.write = ((chunk: any) => {
        captured += String(chunk)
        return true
      }) as any

      try {
        await runMemory({ sessionID, write: "## Goal\n- build a feature", json: true }, ctx)
      } finally {
        process.stdout.write = originalWrite
      }

      const writeData = JSON.parse(captured)
      expect(writeData.action).toBe("write")
      expect(writeData.success).toBe(true)

      // 4. Read back memory
      captured = ""
      process.stdout.write = ((chunk: any) => {
        captured += String(chunk)
        return true
      }) as any

      try {
        await runMemory({ sessionID, json: true }, ctx)
      } finally {
        process.stdout.write = originalWrite
      }

      const readData = JSON.parse(captured)
      expect(readData.exists).toBe(true)
      expect(readData.content).toContain("## Goal\n- build a feature")

      // 5. Append memory
      captured = ""
      process.stdout.write = ((chunk: any) => {
        captured += String(chunk)
        return true
      }) as any

      try {
        await runMemory({ sessionID, append: "## Current State\n- in progress", json: true }, ctx)
      } finally {
        process.stdout.write = originalWrite
      }

      const appendData = JSON.parse(captured)
      expect(appendData.action).toBe("append")
      expect(appendData.success).toBe(true)

      // 6. Verify appended memory
      captured = ""
      process.stdout.write = ((chunk: any) => {
        captured += String(chunk)
        return true
      }) as any

      try {
        await runMemory({ sessionID }, ctx)
      } finally {
        process.stdout.write = originalWrite
      }

      expect(captured).toContain("## Goal\n- build a feature")
      expect(captured).toContain("## Current State\n- in progress")

      // 7. Write from file
      const tmpFile = path.join(tmp.path, "external-memory.md")
      await fs.writeFile(tmpFile, "## External\n- from file", "utf-8")

      captured = ""
      process.stdout.write = ((chunk: any) => {
        captured += String(chunk)
        return true
      }) as any

      try {
        await runMemory({ sessionID, file: tmpFile, json: true }, ctx)
      } finally {
        process.stdout.write = originalWrite
      }

      const fileData = JSON.parse(captured)
      expect(fileData.action).toBe("write")

      // 8. Mutual exclusion check
      const conflictExit = await runMemoryExit({ sessionID, write: "text", clear: true }, ctx)
      expect(Exit.isFailure(conflictExit)).toBe(true)

      // 8a. Write to file via --output
      const outTextFile = path.join(tmp.path, "exported-memory.md")
      await runMemory({ sessionID, output: outTextFile }, ctx)
      const exportedContent = await fs.readFile(outTextFile, "utf-8")
      expect(exportedContent).toContain("## External")

      // 8b. Write to file via --output and --json
      const outJsonFile = path.join(tmp.path, "exported-memory.json")
      captured = ""
      process.stdout.write = ((chunk: any) => {
        captured += String(chunk)
        return true
      }) as any
      try {
        await runMemory({ sessionID, output: outJsonFile, json: true }, ctx)
      } finally {
        process.stdout.write = originalWrite
      }
      const outJsonData = JSON.parse(captured)
      expect(outJsonData.ok).toBe(true)
      const exportedJsonFileContent = JSON.parse(await fs.readFile(outJsonFile, "utf-8"))
      expect(exportedJsonFileContent.sessionID).toBe(sessionID)
      expect(exportedJsonFileContent.content).toContain("## External")

      // 9. Clear memory
      captured = ""
      process.stdout.write = ((chunk: any) => {
        captured += String(chunk)
        return true
      }) as any

      try {
        await runMemory({ sessionID, clear: true, json: true }, ctx)
      } finally {
        process.stdout.write = originalWrite
      }

      const clearData = JSON.parse(captured)
      expect(clearData.action).toBe("clear")
      expect(clearData.success).toBe(true)

      // 10. Verify empty after clear
      captured = ""
      process.stdout.write = ((chunk: any) => {
        captured += String(chunk)
        return true
      }) as any

      try {
        await runMemory({ sessionID, json: true }, ctx)
      } finally {
        process.stdout.write = originalWrite
      }

      const clearedData = JSON.parse(captured)
      expect(clearedData.exists).toBe(false)
      expect(clearedData.content).toBe("")
    } finally {
      await InstanceRuntime.disposeInstance(ctx)
    }
  })

  test("reads, writes, appends, and clears durable memory using alias options (w, a, f, c, o)", async () => {
    const tmp = await tmpdir({ git: true })
    const ctx = await InstanceRuntime.load({ directory: tmp.path })

    try {
      const session = await AppRuntime.runPromise(
        Session.Service.use((svc) => svc.create({})).pipe(Effect.provideService(InstanceRef, ctx)),
      )
      const sessionID = session.id

      // 1. Write memory via alias 'w'
      let captured = ""
      const originalWrite = process.stdout.write
      process.stdout.write = ((chunk: any) => {
        captured += String(chunk)
        return true
      }) as any

      try {
        await runMemory({ sessionID, w: "## Goal\n- via alias w", json: true }, ctx)
      } finally {
        process.stdout.write = originalWrite
      }
      const writeData = JSON.parse(captured)
      expect(writeData.action).toBe("write")
      expect(writeData.success).toBe(true)

      // 2. Append memory via alias 'a'
      captured = ""
      process.stdout.write = ((chunk: any) => {
        captured += String(chunk)
        return true
      }) as any

      try {
        await runMemory({ sessionID, a: "## Appendix\n- via alias a", json: true }, ctx)
      } finally {
        process.stdout.write = originalWrite
      }
      const appendData = JSON.parse(captured)
      expect(appendData.action).toBe("append")
      expect(appendData.success).toBe(true)

      // 3. Export memory via alias 'o'
      const outTextFile = path.join(tmp.path, "alias-memory.md")
      await runMemory({ sessionID, o: outTextFile }, ctx)
      const exportedContent = await fs.readFile(outTextFile, "utf-8")
      expect(exportedContent).toContain("via alias w")
      expect(exportedContent).toContain("via alias a")

      // 4. Write memory via alias 'f'
      const tmpFile = path.join(tmp.path, "file-alias.md")
      await fs.writeFile(tmpFile, "## From File Alias\n- ok", "utf-8")
      captured = ""
      process.stdout.write = ((chunk: any) => {
        captured += String(chunk)
        return true
      }) as any

      try {
        await runMemory({ sessionID, f: tmpFile, json: true }, ctx)
      } finally {
        process.stdout.write = originalWrite
      }
      const fileData = JSON.parse(captured)
      expect(fileData.action).toBe("write")

      // 5. Clear memory via alias 'c'
      captured = ""
      process.stdout.write = ((chunk: any) => {
        captured += String(chunk)
        return true
      }) as any

      try {
        await runMemory({ sessionID, c: true, json: true }, ctx)
      } finally {
        process.stdout.write = originalWrite
      }
      const clearData = JSON.parse(captured)
      expect(clearData.action).toBe("clear")
      expect(clearData.success).toBe(true)
    } finally {
      await InstanceRuntime.disposeInstance(ctx)
    }
  })
})
