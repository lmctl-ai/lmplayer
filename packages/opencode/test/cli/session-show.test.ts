import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import fs from "fs/promises"
import yargs, { type Argv } from "yargs"
import { cliIt } from "../lib/cli-process"
import {
  SessionShowCommand,
  SessionStatusCommand,
  SessionTailCommand,
} from "../../src/cli/cmd/session"

describe("session show/status/tail command builders", () => {
  test("SessionShowCommand registers show, aliases, output, and json options", () => {
    expect(SessionShowCommand.command).toBe("show <sessionID>")
    expect(SessionShowCommand.aliases).toContain("get")
    const builder = SessionShowCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
  })

  test("SessionStatusCommand registers status, output, and json options", () => {
    expect(SessionStatusCommand.command).toBe("status [sessionID]")
    const builder = SessionStatusCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
  })

  test("SessionTailCommand registers tail, lines, output, and json options", () => {
    expect(SessionTailCommand.command).toBe("tail <sessionID>")
    const builder = SessionTailCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.lines).toBeDefined()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
  })
})

describe("opencode session show / get (CLI)", () => {
  cliIt.concurrent(
    "shows session metadata, message counts, tokens, and cost",
    ({ llm, home, opencode }) =>
      Effect.gen(function* () {
        const notFound = "ses_nonexistent999"
        const notFoundRes = yield* opencode.spawn(["session", "show", notFound])
        opencode.expectExit(notFoundRes, 1)
        expect(notFoundRes.stderr).toContain(`Session not found: ${notFound}`)

        const notFoundGet = yield* opencode.spawn(["session", "get", notFound])
        opencode.expectExit(notFoundGet, 1)
        expect(notFoundGet.stderr).toContain(`Session not found: ${notFound}`)

        yield* llm.text("hello world from llm")
        const runRes = yield* opencode.run("say test message", { format: "json" })
        opencode.expectExit(runRes, 0)
        const events = opencode.parseJsonEvents(runRes.stdout)
        const sessionID = events[0]?.sessionID as string
        expect(sessionID).toBeDefined()

        // 1. Text output format for session show
        const showRes = yield* opencode.spawn(["session", "show", sessionID])
        opencode.expectExit(showRes, 0)
        expect(showRes.stderr).toContain(sessionID)
        expect(showRes.stderr).toContain("Messages:")
        expect(showRes.stderr).toContain("Tokens:")

        // 2. JSON output format for session show
        const showJsonRes = yield* opencode.spawn(["session", "show", sessionID, "--json"])
        opencode.expectExit(showJsonRes, 0)
        const showData = JSON.parse(showJsonRes.stdout)
        expect(showData.id).toBe(sessionID)
        expect(showData.title).toBeDefined()
        expect(showData.cost).toBeDefined()
        expect(showData.tokens).toBeDefined()
        expect(showData.tokens.input).toBeGreaterThanOrEqual(0)
        expect(showData.messages).toBeGreaterThan(0)
        expect(showData.turns.user).toBeGreaterThan(0)
        expect(showData.turns.assistant).toBeGreaterThan(0)

        // 2b. Direct file export for session show (text & json)
        const showOutFile = path.join(home, "show.txt")
        const showOutRes = yield* opencode.spawn(["session", "show", sessionID, "-o", showOutFile])
        opencode.expectExit(showOutRes, 0)
        expect(showOutRes.stderr).toContain(`Wrote session details to ${showOutFile}`)
        const showFileContent = yield* Effect.promise(() => fs.readFile(showOutFile, "utf-8"))
        expect(showFileContent).toContain(sessionID)
        expect(showFileContent).toContain("Messages:")

        const showJsonFile = path.join(home, "show.json")
        const showJsonOutRes = yield* opencode.spawn(["session", "show", sessionID, "--json", "-o", showJsonFile])
        opencode.expectExit(showJsonOutRes, 0)
        expect(showJsonOutRes.stderr).toContain(`Wrote session details to ${showJsonFile}`)
        const showJsonParsed = JSON.parse(yield* Effect.promise(() => fs.readFile(showJsonFile, "utf-8")))
        expect(showJsonParsed.id).toBe(sessionID)

        // 3. Alias `get` works identically
        const getJsonRes = yield* opencode.spawn(["session", "get", sessionID, "--json"])
        opencode.expectExit(getJsonRes, 0)
        const getData = JSON.parse(getJsonRes.stdout)
        expect(getData.id).toBe(sessionID)
        expect(getData.title).toBe(showData.title)

        // 4. Record durable memory and verify session show includes memory info
        const memRes = yield* opencode.spawn([
          "session",
          "memory",
          sessionID,
          "--write",
          "Important project note for test session",
          "--json",
        ])
        opencode.expectExit(memRes, 0)

        const showWithMemRes = yield* opencode.spawn(["session", "show", sessionID, "--json"])
        opencode.expectExit(showWithMemRes, 0)
        const showWithMemData = JSON.parse(showWithMemRes.stdout)
        expect(showWithMemData.memory.exists).toBe(true)
        expect(showWithMemData.memory.bytes).toBeGreaterThan(0)
        expect(showWithMemData.status).toBeDefined()
        expect(showWithMemData.status.type).toBe("idle")

        // 5. Test session status command
        // 5a. Non-existent session status fails cleanly
        const statusNotFoundRes = yield* opencode.spawn(["session", "status", notFound])
        opencode.expectExit(statusNotFoundRes, 1)
        expect(statusNotFoundRes.stderr).toContain(`Session not found: ${notFound}`)

        // 5b. All sessions status (human and JSON)
        const statusAllRes = yield* opencode.spawn(["session", "status"])
        opencode.expectExit(statusAllRes, 0)
        expect(statusAllRes.stderr).toBeDefined()

        const statusAllJsonRes = yield* opencode.spawn(["session", "status", "--json"])
        opencode.expectExit(statusAllJsonRes, 0)
        const statusAllData = JSON.parse(statusAllJsonRes.stdout)
        expect(typeof statusAllData).toBe("object")

        // 5c. Specific session status (human and JSON)
        const statusSingleRes = yield* opencode.spawn(["session", "status", sessionID])
        opencode.expectExit(statusSingleRes, 0)
        expect(statusSingleRes.stderr).toContain(`Session ${sessionID}: idle`)

        const statusSingleJsonRes = yield* opencode.spawn(["session", "status", sessionID, "--json"])
        opencode.expectExit(statusSingleJsonRes, 0)
        const statusSingleData = JSON.parse(statusSingleJsonRes.stdout)
        expect(statusSingleData.id).toBe(sessionID)
        expect(statusSingleData.status.type).toBe("idle")

        // 5d. Session status with -o output file (single session & all sessions)
        const statusSingleOut = path.join(home, "status-single.txt")
        const statusSingleOutRes = yield* opencode.spawn(["session", "status", sessionID, "-o", statusSingleOut])
        opencode.expectExit(statusSingleOutRes, 0)
        expect(statusSingleOutRes.stderr).toContain(`Wrote status to ${statusSingleOut}`)
        const statusSingleContent = yield* Effect.promise(() => fs.readFile(statusSingleOut, "utf-8"))
        expect(statusSingleContent).toContain(`Session ${sessionID}: idle`)

        const statusSingleJsonOut = path.join(home, "status-single.json")
        const statusSingleJsonOutRes = yield* opencode.spawn(["session", "status", sessionID, "--json", "-o", statusSingleJsonOut])
        opencode.expectExit(statusSingleJsonOutRes, 0)
        expect(statusSingleJsonOutRes.stderr).toContain(`Wrote status to ${statusSingleJsonOut}`)
        const statusSingleJsonParsed = JSON.parse(yield* Effect.promise(() => fs.readFile(statusSingleJsonOut, "utf-8")))
        expect(statusSingleJsonParsed.id).toBe(sessionID)
        expect(statusSingleJsonParsed.status.type).toBe("idle")

        const statusAllOut = path.join(home, "status-all.txt")
        const statusAllOutRes = yield* opencode.spawn(["session", "status", "-o", statusAllOut])
        opencode.expectExit(statusAllOutRes, 0)
        expect(statusAllOutRes.stderr).toContain(`Wrote status to ${statusAllOut}`)
        const statusAllContent = yield* Effect.promise(() => fs.readFile(statusAllOut, "utf-8"))
        expect(statusAllContent.length).toBeGreaterThan(0)

        const statusAllJsonOut = path.join(home, "status-all.json")
        const statusAllJsonOutRes = yield* opencode.spawn(["session", "status", "--json", "-o", statusAllJsonOut])
        opencode.expectExit(statusAllJsonOutRes, 0)
        expect(statusAllJsonOutRes.stderr).toContain(`Wrote status to ${statusAllJsonOut}`)
        const statusAllJsonParsed = JSON.parse(yield* Effect.promise(() => fs.readFile(statusAllJsonOut, "utf-8")))
        expect(typeof statusAllJsonParsed).toBe("object")

        // 6. Test session tail with -o output file (text and JSON)
        const tailOut = path.join(home, "tail.txt")
        const tailOutRes = yield* opencode.spawn(["session", "tail", sessionID, "-o", tailOut])
        opencode.expectExit(tailOutRes, 0)
        expect(tailOutRes.stderr).toContain(`Wrote messages to ${tailOut}`)
        const tailContent = yield* Effect.promise(() => fs.readFile(tailOut, "utf-8"))
        expect(tailContent).toContain("say test message")

        const tailJsonOut = path.join(home, "tail.json")
        const tailJsonOutRes = yield* opencode.spawn(["session", "tail", sessionID, "--json", "-o", tailJsonOut])
        opencode.expectExit(tailJsonOutRes, 0)
        expect(tailJsonOutRes.stderr).toContain(`Wrote messages to ${tailJsonOut}`)
        const tailJsonParsed = JSON.parse(yield* Effect.promise(() => fs.readFile(tailJsonOut, "utf-8")))
        expect(Array.isArray(tailJsonParsed)).toBe(true)
        expect(tailJsonParsed.length).toBeGreaterThan(0)
        expect(tailJsonParsed[0].text).toContain("say test message")
      }),
    60_000,
  )
})
