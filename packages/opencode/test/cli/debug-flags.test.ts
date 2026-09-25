import { describe, expect, test } from "bun:test"
import yargs, { type Argv } from "yargs"
import { ConfigCommand } from "../../src/cli/cmd/debug/config"
import { ScrapCommand } from "../../src/cli/cmd/debug/scrap"
import { SkillCommand } from "../../src/cli/cmd/debug/skill"
import { StartupCommand } from "../../src/cli/cmd/debug/startup"
import { V2Command } from "../../src/cli/cmd/debug/v2"
import { AgentCommand } from "../../src/cli/cmd/debug/agent"
import { InfoCommand, PathsCommand } from "../../src/cli/cmd/debug/index"
import { FilesCommand, SearchCommand } from "../../src/cli/cmd/debug/ripgrep"
import { FileSearchCommand, FileReadCommand, FileListCommand } from "../../src/cli/cmd/debug/file"
import { TrackCommand, PatchCommand, DiffCommand } from "../../src/cli/cmd/debug/snapshot"
import { DiagnosticsCommand, SymbolsCommand, DocumentSymbolsCommand } from "../../src/cli/cmd/debug/lsp"

describe("debug command builders output and json options", () => {
  const commands = [
    { name: "debug config", cmd: ConfigCommand },
    { name: "debug info", cmd: InfoCommand },
    { name: "debug paths", cmd: PathsCommand },
    { name: "debug scrap", cmd: ScrapCommand },
    { name: "debug skill", cmd: SkillCommand },
    { name: "debug startup", cmd: StartupCommand },
    { name: "debug v2", cmd: V2Command },
    { name: "debug agent", cmd: AgentCommand },
    { name: "debug rg files", cmd: FilesCommand },
    { name: "debug rg search", cmd: SearchCommand },
    { name: "debug file search", cmd: FileSearchCommand },
    { name: "debug file read", cmd: FileReadCommand },
    { name: "debug file list", cmd: FileListCommand },
    { name: "debug snapshot track", cmd: TrackCommand },
    { name: "debug snapshot patch", cmd: PatchCommand },
    { name: "debug snapshot diff", cmd: DiffCommand },
    { name: "debug lsp diagnostics", cmd: DiagnosticsCommand },
    { name: "debug lsp symbols", cmd: SymbolsCommand },
    { name: "debug lsp document-symbols", cmd: DocumentSymbolsCommand },
  ]


  test("FilesCommand and SearchCommand register and parse option aliases -q, -g, -n, -o", async () => {
    const filesBuilder = FilesCommand.builder as (y: Argv) => Argv<any>
    const filesParser = filesBuilder(yargs())
    const filesOpts = (filesParser as any).getOptions()
    expect(filesOpts.key.query).toBeDefined()
    expect(filesOpts.key.q).toBeDefined()
    expect(filesOpts.key.glob).toBeDefined()
    expect(filesOpts.key.g).toBeDefined()
    expect(filesOpts.key.limit).toBeDefined()
    expect(filesOpts.key.n).toBeDefined()
    expect(filesOpts.key.output).toBeDefined()
    expect(filesOpts.key.o).toBeDefined()

    const filesParsed = await filesParser.parseAsync(["-q", "test", "-g", "*.ts", "-n", "50", "-o", "out.txt", "--json"])
    expect(filesParsed.q).toBe("test")
    expect(filesParsed.g).toBe("*.ts")
    expect(filesParsed.n).toBe(50)
    expect(filesParsed.o).toBe("out.txt")
    expect(filesParsed.json).toBe(true)

    const searchBuilder = SearchCommand.builder as (y: Argv) => Argv<any>
    const searchParser = searchBuilder(yargs())
    const searchOpts = (searchParser as any).getOptions()
    expect(searchOpts.key.glob).toBeDefined()
    expect(searchOpts.key.g).toBeDefined()
    expect(searchOpts.key.limit).toBeDefined()
    expect(searchOpts.key.n).toBeDefined()
    expect(searchOpts.key.output).toBeDefined()
    expect(searchOpts.key.o).toBeDefined()

    const searchParsed = await yargs()
      .command({ ...SearchCommand, handler: () => {} })
      .parseAsync(["search", "pattern", "-g", "*.ts", "-n", "10", "-o", "res.json"])
    expect(searchParsed.pattern).toBe("pattern")
    expect(searchParsed.g).toEqual(["*.ts"])
    expect(searchParsed.n).toBe(10)
    expect(searchParsed.o).toBe("res.json")
  })

  test("AgentCommand registers and parses option aliases -t, -p, -o", async () => {
    const agentBuilder = AgentCommand.builder as (y: Argv) => Argv<any>
    const agentParser = agentBuilder(yargs())
    const agentOpts = (agentParser as any).getOptions()
    expect(agentOpts.key.tool).toBeDefined()
    expect(agentOpts.key.t).toBeDefined()
    expect(agentOpts.key.params).toBeDefined()
    expect(agentOpts.key.p).toBeDefined()
    expect(agentOpts.key.output).toBeDefined()
    expect(agentOpts.key.o).toBeDefined()
    expect(agentOpts.key.json).toBeDefined()

    const parsed = await yargs()
      .command({ ...AgentCommand, handler: () => {} })
      .parseAsync(["agent", "coder", "-t", "bash", "-p", "{}", "-o", "agent.json", "--json"])
    expect(parsed.name).toBe("coder")
    expect(parsed.t).toBe("bash")
    expect(parsed.p).toBe("{}")
    expect(parsed.o).toBe("agent.json")
    expect(parsed.json).toBe(true)
  })

  test("debug file commands parse -o and --json options", async () => {
    const searchParsed = await yargs()
      .command({ ...FileSearchCommand, handler: () => {} })
      .parseAsync(["search", "test-query", "-o", "found.txt", "--json"])
    expect(searchParsed.query).toBe("test-query")
    expect(searchParsed.o).toBe("found.txt")
    expect(searchParsed.json).toBe(true)

    const readParsed = await yargs()
      .command({ ...FileReadCommand, handler: () => {} })
      .parseAsync(["read", "src/index.ts", "-o", "content.json", "--json"])
    expect(readParsed.path).toBe("src/index.ts")
    expect(readParsed.o).toBe("content.json")
    expect(readParsed.json).toBe(true)

    const listParsed = await yargs()
      .command({ ...FileListCommand, handler: () => {} })
      .parseAsync(["list", "src", "-o", "list.json", "--json"])
    expect(listParsed.path).toBe("src")
    expect(listParsed.o).toBe("list.json")
    expect(listParsed.json).toBe(true)
  })

  test("debug snapshot and lsp commands parse -o and --json options", async () => {
    const trackParsed = await yargs()
      .command({ ...TrackCommand, handler: () => {} })
      .parseAsync(["track", "-o", "track.json", "--json"])
    expect(trackParsed.o).toBe("track.json")
    expect(trackParsed.json).toBe(true)

    const patchParsed = await yargs()
      .command({ ...PatchCommand, handler: () => {} })
      .parseAsync(["patch", "abc1234", "-o", "patch.diff", "--json"])
    expect(patchParsed.hash).toBe("abc1234")
    expect(patchParsed.o).toBe("patch.diff")
    expect(patchParsed.json).toBe(true)

    const diffParsed = await yargs()
      .command({ ...DiffCommand, handler: () => {} })
      .parseAsync(["diff", "abc1234", "-o", "diff.txt", "--json"])
    expect(diffParsed.hash).toBe("abc1234")
    expect(diffParsed.o).toBe("diff.txt")
    expect(diffParsed.json).toBe(true)

    const diagParsed = await yargs()
      .command({ ...DiagnosticsCommand, handler: () => {} })
      .parseAsync(["diagnostics", "file.ts", "-o", "diag.json", "--json"])
    expect(diagParsed.file).toBe("file.ts")
    expect(diagParsed.o).toBe("diag.json")
    expect(diagParsed.json).toBe(true)

    const symParsed = await yargs()
      .command({ ...SymbolsCommand, handler: () => {} })
      .parseAsync(["symbols", "mySymbol", "-o", "sym.json", "--json"])
    expect(symParsed.query).toBe("mySymbol")
    expect(symParsed.o).toBe("sym.json")
    expect(symParsed.json).toBe(true)

    const docSymParsed = await yargs()
      .command({ ...DocumentSymbolsCommand, handler: () => {} })
      .parseAsync(["document-symbols", "file:///doc.ts", "-o", "docsym.json", "--json"])
    expect(docSymParsed.uri).toBe("file:///doc.ts")
    expect(docSymParsed.o).toBe("docsym.json")
    expect(docSymParsed.json).toBe(true)
  })

  for (const { name, cmd } of commands) {
    test(`${name} registers output and json options`, () => {
      const builder = cmd.builder as (y: Argv) => Argv<any>
      expect(builder).toBeDefined()
      const parser = builder(yargs())
      const options = (parser as any).getOptions()
      expect(options.key.output).toBeDefined()
      expect(options.key.o).toBeDefined()
      expect(options.key.json).toBeDefined()
    })
  }
})
