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
