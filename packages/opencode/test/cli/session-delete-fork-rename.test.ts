import { describe, expect, test } from "bun:test"
import yargs, { type Argv } from "yargs"
import {
  SessionDeleteCommand,
  SessionRenameCommand,
  SessionForkCommand,
  SessionShareCommand,
  SessionUnshareCommand,
  SessionCompactCommand,
  SessionJobsCommand,
} from "../../src/cli/cmd/session"

describe("Session delete, rename, fork, share, unshare option builders", () => {
  test("SessionDeleteCommand registers force (-f), output (-o), and json options", () => {
    expect(SessionDeleteCommand.command).toBe("delete <sessionID> [extraSessionIDs..]")
    const builder = SessionDeleteCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.force).toBeDefined()
    expect(options.key.f).toBeDefined()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
    expect(options.boolean).toContain("json")
  })

  test("SessionDeleteCommand parses -f, -o, and --json options from arguments", async () => {
    const parsed = await yargs()
      .command({ ...SessionDeleteCommand, handler: () => {} })
      .parseAsync(["delete", "ses_123", "ses_456", "-f", "-o", "deleted.txt", "--json"])
    expect(parsed.sessionID).toBe("ses_123")
    expect(parsed.extraSessionIDs).toEqual(["ses_456"])
    expect(parsed.force).toBe(true)
    expect(parsed.f).toBe(true)
    expect(parsed.output).toBe("deleted.txt")
    expect(parsed.o).toBe("deleted.txt")
    expect(parsed.json).toBe(true)
  })

  test("SessionRenameCommand registers output (-o) and json options", () => {
    expect(SessionRenameCommand.command).toBe("rename <sessionID> <title>")
    const builder = SessionRenameCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
    expect(options.boolean).toContain("json")
  })

  test("SessionRenameCommand parses positionals and -o, --json flags", async () => {
    const parsed = await yargs()
      .command({ ...SessionRenameCommand, handler: () => {} })
      .parseAsync(["rename", "ses_test", "Brand New Title", "-o", "renamed.json", "--json"])
    expect(parsed.sessionID).toBe("ses_test")
    expect(parsed.title).toBe("Brand New Title")
    expect(parsed.output).toBe("renamed.json")
    expect(parsed.o).toBe("renamed.json")
    expect(parsed.json).toBe(true)
  })

  test("SessionForkCommand registers title (-t), message (-m), output (-o), and json options", () => {
    expect(SessionForkCommand.command).toBe("fork <sessionID>")
    const builder = SessionForkCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.title).toBeDefined()
    expect(options.key.t).toBeDefined()
    expect(options.key.message).toBeDefined()
    expect(options.key.m).toBeDefined()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
    expect(options.boolean).toContain("json")
  })

  test("SessionForkCommand parses positionals and -t, -m, -o, --json flags", async () => {
    const parsed = await yargs()
      .command({ ...SessionForkCommand, handler: () => {} })
      .parseAsync(["fork", "ses_orig", "-t", "Forked Title", "-m", "msg_step3", "-o", "forked.json", "--json"])
    expect(parsed.sessionID).toBe("ses_orig")
    expect(parsed.title).toBe("Forked Title")
    expect(parsed.t).toBe("Forked Title")
    expect(parsed.message).toBe("msg_step3")
    expect(parsed.m).toBe("msg_step3")
    expect(parsed.output).toBe("forked.json")
    expect(parsed.o).toBe("forked.json")
    expect(parsed.json).toBe(true)
  })

  test("SessionShareCommand registers output (-o), json, and unshare options", () => {
    expect(SessionShareCommand.command).toBe("share <sessionID>")
    const builder = SessionShareCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
    expect(options.key.unshare).toBeDefined()
  })

  test("SessionShareCommand parses positionals and -o, --json flags", async () => {
    const parsed = await yargs()
      .command({ ...SessionShareCommand, handler: () => {} })
      .parseAsync(["share", "ses_share_1", "-o", "share.json", "--json"])
    expect(parsed.sessionID).toBe("ses_share_1")
    expect(parsed.output).toBe("share.json")
    expect(parsed.o).toBe("share.json")
    expect(parsed.json).toBe(true)
  })

  test("SessionUnshareCommand registers output (-o) and json options", () => {
    expect(SessionUnshareCommand.command).toBe("unshare <sessionID>")
    const builder = SessionUnshareCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
  })

  test("SessionUnshareCommand parses positionals and -o, --json flags", async () => {
    const parsed = await yargs()
      .command({ ...SessionUnshareCommand, handler: () => {} })
      .parseAsync(["unshare", "ses_unshare_1", "-o", "unshare.json", "--json"])
    expect(parsed.sessionID).toBe("ses_unshare_1")
    expect(parsed.output).toBe("unshare.json")
    expect(parsed.o).toBe("unshare.json")
    expect(parsed.json).toBe(true)
  })

  test("SessionCompactCommand registers model (-m), auto, output (-o), and json options", () => {
    expect(SessionCompactCommand.command).toBe("compact <sessionID>")
    expect(SessionCompactCommand.aliases).toContain("summarize")
    const builder = SessionCompactCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.model).toBeDefined()
    expect(options.key.m).toBeDefined()
    expect(options.key.auto).toBeDefined()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
    expect(options.boolean).toContain("json")
  })

  test("SessionCompactCommand parses positionals and -m, --auto, -o, --json flags", async () => {
    const parsed = await yargs()
      .command({ ...SessionCompactCommand, handler: () => {} })
      .parseAsync(["compact", "ses_compact_1", "-m", "anthropic/claude-sonnet-4-0", "--auto", "-o", "compact.json", "--json"])
    expect(parsed.sessionID).toBe("ses_compact_1")
    expect(parsed.model).toBe("anthropic/claude-sonnet-4-0")
    expect(parsed.m).toBe("anthropic/claude-sonnet-4-0")
    expect(parsed.auto).toBe(true)
    expect(parsed.output).toBe("compact.json")
    expect(parsed.o).toBe("compact.json")
    expect(parsed.json).toBe(true)
  })

  test("SessionJobsCommand registers output (-o), job (-j), status (-s), file, and json options", () => {
    expect(SessionJobsCommand.command).toBe("jobs <sessionID>")
    const builder = SessionJobsCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.job).toBeDefined()
    expect(options.key.j).toBeDefined()
    expect(options.key.status).toBeDefined()
    expect(options.key.s).toBeDefined()
    expect(options.key.file).toBeDefined()
    expect(options.key.json).toBeDefined()
    expect(options.boolean).toContain("json")
  })

  test("SessionJobsCommand parses positionals and -o, -j, -s, --file, --json flags", async () => {
    const parsed = await yargs()
      .command({ ...SessionJobsCommand, handler: () => {} })
      .parseAsync(["jobs", "ses_job_test", "-o", "job_123", "-j", "job_456", "-s", "running", "--file", "jobs.json", "--json"])
    expect(parsed.sessionID).toBe("ses_job_test")
    expect(parsed.output).toBe("job_123")
    expect(parsed.o).toBe("job_123")
    expect(parsed.job).toBe("job_456")
    expect(parsed.j).toBe("job_456")
    expect(parsed.status).toBe("running")
    expect(parsed.s).toBe("running")
    expect(parsed.file).toBe("jobs.json")
    expect(parsed.json).toBe(true)
  })
})
