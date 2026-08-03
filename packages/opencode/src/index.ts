import { Effect } from "effect"
import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { RunCommand } from "./cli/cmd/run"
import { GenerateCommand } from "./cli/cmd/generate"
import { ConsoleCommand } from "./cli/cmd/account"
import { ProvidersCommand } from "./cli/cmd/providers"
import { AgentCommand } from "./cli/cmd/agent"
import { UpgradeCommand } from "./cli/cmd/upgrade"
import { UninstallCommand } from "./cli/cmd/uninstall"
import { ModelsCommand } from "./cli/cmd/models"
import { UI } from "./cli/ui"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { FormatError } from "./cli/error"
import { ServeCommand } from "./cli/cmd/serve"
import { DebugCommand } from "./cli/cmd/debug"
import { StatsCommand } from "./cli/cmd/stats"
import { McpCommand } from "./cli/cmd/mcp"
import { GithubCommand } from "./cli/cmd/github"
import { ExportCommand } from "./cli/cmd/export"
import { ImportCommand } from "./cli/cmd/import"
import { AttachCommand } from "./cli/cmd/attach"
import { TuiThreadCommand } from "./cli/cmd/tui"
import { AcpCommand } from "./cli/cmd/acp"
import { EOL } from "os"
import { WebCommand } from "./cli/cmd/web"
import { PrCommand } from "./cli/cmd/pr"
import { SessionCommand } from "./cli/cmd/session"
import { ConfigCommand } from "./cli/cmd/config"
import { OrchestratorCommand } from "./cli/cmd/orchestrator"
import { DbCommand } from "./cli/cmd/db"
import { errorMessage } from "./util/error"
import { PluginCommand } from "./cli/cmd/plug"
import { Heap } from "./cli/heap"

const args = hideBin(process.argv)

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("opencode ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text + EOL)
    return
  }
  process.stderr.write(out)
}

// Default action: `lmplayer <message>` runs a non-interactive prompt (same as
// `lmplayer run <message>`). With no message and nothing piped on stdin, print
// help instead of launching anything. Reuses RunCommand's builder/handler so
// the run loop is not duplicated; mini defaults to false here, so run's
// interactive guard stays inert.
const DefaultCommand = {
  command: "$0 [message..]",
  describe: "send a prompt (run non-interactively); use a subcommand for other actions",
  builder: RunCommand.builder,
  handler: async (argv: Parameters<NonNullable<typeof RunCommand.handler>>[0]) => {
    if (argv.mini) {
      UI.error("interactive --mini is not available on the default command; use 'lmplayer tui' or 'lmplayer run --mini'")
      process.exit(1)
    }
    const hasMessage = (argv.message ?? []).length > 0 || (argv["--"] ?? []).length > 0
    if (!hasMessage && !argv.command && process.stdin.isTTY) {
      cli.showHelp(show)
      return
    }
    await RunCommand.handler!(argv)
  },
}

const cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName("lmplayer")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .middleware(async (opts) => {
    if (opts.printLogs) process.env.OPENCODE_PRINT_LOGS = "1"
    if (opts.logLevel) process.env.OPENCODE_LOG_LEVEL = opts.logLevel
    if (opts.pure) {
      process.env.OPENCODE_PURE = "1"
    }

    Heap.start()

    process.env.AGENT = "1"
    process.env.OPENCODE = "1"
    process.env.OPENCODE_PID = String(process.pid)
  })
  .usage("")
  .completion("completion", "generate shell completion script")
  .command(AcpCommand)
  .command(McpCommand)
  .command(TuiThreadCommand)
  .command(DefaultCommand)
  .command(AttachCommand)
  .command(RunCommand)
  .command(GenerateCommand)
  .command(DebugCommand)
  .command(ConsoleCommand)
  .command(ProvidersCommand)
  .command(AgentCommand)
  .command(UpgradeCommand)
  .command(UninstallCommand)
  .command(ServeCommand)
  .command(WebCommand)
  .command(ModelsCommand)
  .command(StatsCommand)
  .command(ExportCommand)
  .command(ImportCommand)
  .command(GithubCommand)
  .command(PrCommand)
  .command(SessionCommand)
  .command(ConfigCommand)
  .command(OrchestratorCommand)
  .command(PluginCommand)
  .command(DbCommand)
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

try {
  if ((args.length === 0 && process.stdin.isTTY) || args.includes("-h") || args.includes("--help")) {
    await cli.parse(args.length === 0 ? ["--help"] : args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
  }
} catch (e) {
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  // Explicitly (not via a Scope finalizer — see SessionJobRuntime.shutdown's doc comment;
  // it's built through a shared, process-lifetime memoMap, so disposing any single
  // ManagedRuntime built atop that memoMap does not reliably close its own construction
  // scope) terminate any still-running background session jobs this process owns, in a
  // bounded window, before the hard exit below. Without this, jobs left running when a
  // one-shot command (e.g. `opencode run`) exits become untracked orphans: nothing ever
  // signals them to stop, and their eventual completion is never observed or reported.
  //
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses — the timeout below caps how long
  // graceful shutdown can take before we fall back to the original hard-exit behavior.
  const { AppRuntime } = await import("@/effect/app-runtime")
  const { SessionJobRuntime } = await import("@/session/job-runtime")
  const shutdown = await Promise.race([
    AppRuntime.runPromise(SessionJobRuntime.Service.pipe(Effect.flatMap((service) => service.shutdown()))).then(
      () => ({ type: "complete" as const }),
      (error) => ({ type: "failed" as const, error }),
    ),
    new Promise<{ type: "timeout" }>((resolve) => setTimeout(() => resolve({ type: "timeout" }), 10000)),
  ])
  if (shutdown.type === "failed") {
    process.stderr.write(`Background job shutdown failed: ${errorMessage(shutdown.error)}${EOL}`)
  }
  if (shutdown.type === "timeout") {
    process.stderr.write(`Background job shutdown exceeded 10 seconds; forcing process exit${EOL}`)
  }
  process.exit()
}
