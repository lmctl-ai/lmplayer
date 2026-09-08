# lmplayer

An open source AI coding agent built for agents, scripts, and unattended workflows. Send prompts from the command line, run a single-user REST service, or open the optional terminal UI.

lmplayer is a fork of [anomalyco/opencode](https://github.com/anomalyco/opencode). It builds on OpenCode's provider support, coding tools, sessions, subagents, MCP integration, and client/server architecture. It is independently maintained and is not affiliated with or built by the OpenCode team.

## What differs from OpenCode?

These are lmplayer additions and behavior changes relative to the upstream snapshot tracked by this checkout (`9f69463f1d`, August 31, 2026), rather than a claim about every future OpenCode release.

| Area                                                      | lmplayer addition or change                                                                                                                                                                                                                     |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI by default                                            | `lmplayer "your prompt"` runs non-interactively; piped input works too. Bare `lmplayer` on a terminal shows help. Launch the TUI explicitly with `lmplayer tui`.                                                                                |
| Background shell execution (`run_in_background` behavior) | The `bash` tool accepts **`background: true`**, returns a job ID immediately, and delivers completion as a follow-up session turn. The `job` tool lists jobs, inspects state, reads captured output, and stops jobs. Job records are persisted. |
| Internal cron                                             | A session-scoped `cron` tool creates, lists, and deletes recurring or one-shot prompt schedules using five-field cron expressions. No external system crontab is required.                                                                      |
| Durable-memory compaction                                 | The default `organize` mode rewrites a session-owned Markdown memory file and injects it into later turns. Traditional summary compaction remains available through `compaction.mode: "summary"`.                                               |
| File-based permission decisions                           | On the active `run`/`serve` permission path, residual `ask` rules resolve through `permission_ask: "deny"` (default) or `"allow"`, instead of waiting for a human prompt. Explicit allow/deny rules still apply.                                |
| Local project configuration                               | Project config discovery uses the starting directory and its own `.opencode` directory instead of walking through parent directories. Global configuration and explicit config overrides remain supported.                                      |
| Sequential service execution                              | A process-wide FIFO gate serializes execution requests across sessions. Read-only and control endpoints remain responsive; in-process subagents bypass the gate. Background-job notifications and cron turns also use the gate.                 |
| CLI configuration and model discovery                     | `config get/set/unset/verify`, JSON model and provider listings, model verification and live probes, and the `--effort` alias make setup accessible to scripts.                                                                                 |
| Session observability                                     | `session tail`, `report`, `health`, and `metrics` expose history and diagnostics. `session metrics --json` provides the `session-metrics/v1` contract for token usage, estimated cost, latency, tool use, and touched files.                    |
| Positive tool provisioning                                | Agent profiles can declare `provision` to limit which tool definitions reach the model. The built-in `lean` agent uses a short prompt and a bash-only tool set. Permission checks still apply.                                                  |
| Local Ollama support                                      | Use `ollama/<model>` without declaring the provider or supplying an API key. Supports `OLLAMA_HOST`, per-model `@host` selection, chat-only defaults, and explicit `+tools` opt-in.                                                             |
| Structured Linux tools                                    | Dedicated tools for commands such as `git`, `gh`, `rg`, `find`, `tar`, and `unzip` support operation-specific permission checks. A `secured` agent provides a starting point for restricted tool use.                                           |
| Remote operator polling (prototype)                       | `run --remote-poll` receives instructions through an outbound HTTP mailbox and submits them through the normal session prompt path. Useful when the machine cannot accept inbound connections.                                                  |
| Separate application storage                              | XDG config, data, cache, and state directories use `lmplayer`, keeping them separate from an OpenCode installation.                                                                                                                             |
| TUI adjustments                                           | Terminal titles identify `lmplayer`, the sidebar starts hidden, and resizing forces a full repaint.                                                                                                                                             |

Background **subagent** execution is also available through the `task` tool's `background: true` option. This capability is shared with the tracked upstream baseline; it is separate from lmplayer's persisted background **shell jobs**.

### Background jobs and internal cron

These are model-facing tools in the default `run`/`serve` runtime, not top-level CLI flags. The separate V2 core runtime does not yet implement these background shell jobs. An agent can call the `bash` tool with:

```json
{
  "command": "bun run build",
  "background": true
}
```

The `job` tool supports `list`, `get`, `output`, and `stop`. Job metadata and captured output are stored for later inspection, and completion can wake the session so the agent can continue working. Persistence does not mean a running command is automatically restarted: graceful shutdown stops this process's jobs, and recovery reconciles stored job state.

For recurring work, an agent can call `cron` with:

```json
{
  "action": "create",
  "cron": "*/15 * * * *",
  "prompt": "Check the build status and report any failures.",
  "recurring": true
}
```

Cron expressions use local time. Set `recurring` to `false` to fire once at the next matching time. Schedules are **in memory**: they disappear when the process exits, and recurring schedules expire after seven days. Keep the hosting process running for scheduled work; cron creation is permission-checked.

## Build and install from source

Use the Bun version specified by `packageManager` in [package.json](package.json) (currently Bun 1.3.14).

```bash
git clone https://github.com/lmctl-ai/lmplayer.git
cd lmplayer
bun install
cd packages/opencode
bun run build --single --skip-install
```

This builds a native executable for the current platform, including the embedded web UI. Add `--skip-embed-web-ui` for a build without the embedded web app.

On Linux x64, install the result into a directory on your PATH:

```bash
mkdir -p "$HOME/.local/bin"
install -m 755 dist/opencode-linux-x64/bin/lmplayer "$HOME/.local/bin/lmplayer.new"
mv "$HOME/.local/bin/lmplayer.new" "$HOME/.local/bin/lmplayer"
export PATH="$HOME/.local/bin:$PATH"
lmplayer --version
```

Other platforms produce a corresponding `dist/opencode-<platform>-<arch>/bin/` directory. The internal package name remains `opencode`; the executable is `lmplayer`. OpenCode's upstream package-manager and installer commands install OpenCode, so use this checkout to build lmplayer.

For development without compiling, run from the repository root:

```bash
bun dev --help
bun dev tui
```

## Quick start

```bash
# Authenticate with a supported provider
lmplayer providers login

# Discover models and available reasoning-effort variants
lmplayer models --json
lmplayer providers list --json

# Run a prompt with a provider/model ID selected from the model list
lmplayer run --model "<provider/model>" --effort high "Explain this repository"
lmplayer "Fix the failing test and verify the change"

# Validate configuration, open the TUI, or start the REST service
lmplayer config verify
lmplayer tui
lmplayer serve --hostname 127.0.0.1 --port 4096

# Inspect an existing session without running it again
lmplayer session ls --json
lmplayer session metrics "<sessionID>" --json
lmplayer session health "<sessionID>" --json
```

Model availability and effort tiers depend on the provider and account. `lmplayer models --test <provider>` sends real probe requests; `lmplayer models verify <provider/model>` checks model resolution and availability without being an end-to-end generation test.

For a running Ollama server with the model already downloaded:

```bash
lmplayer run --model ollama/qwen2.5 "Hello"
lmplayer run --agent lean --model ollama/qwen2.5+tools "List the files here"
```

Ollama models default to chat-only. `+tools` enables tool calls; choose a model that supports them. The `lean` agent offers bash, which can execute arbitrary shell commands.

## Configuration and memory

The default global config directory is `~/.config/lmplayer` (or `$XDG_CONFIG_HOME/lmplayer`). Config filenames remain `opencode.json` / `opencode.jsonc`, and many inherited environment variables still use the `OPENCODE_*` prefix.

```bash
lmplayer config get
lmplayer config set compaction.mode organize
lmplayer config set permission_ask deny
lmplayer config verify
```

Runtime session memory lives under `$XDG_DATA_HOME/lmplayer/session/<sessionID>/durable-memory/index.md`, with `~/.local/share` as the default data root. It is separate from this repository's [durable-memory/](durable-memory/index.md), which records project decisions, implementation notes, and operating guidance.

The remote-poll channel remains a prototype: its cursor resets on restart, and `delta` replies currently behave like `full` replies. Session cost metrics are derived estimates from recorded usage and available model pricing, not billing statements.

## Documentation and contributing

- [Changelog](CHANGELOG.md): lmplayer changes and upstream refreshes.
- [Project memory](durable-memory/index.md): feature designs, contracts, and known limitations. Older entries use the former name `lmcode`; some historical status notes have been superseded.
- [Contributing](CONTRIBUTING.md) and [repository instructions](AGENTS.md): development conventions. Run tests and typechecks from the relevant package directory.
- [Upstream OpenCode](https://github.com/anomalyco/opencode): the original project and shared functionality.

The other `README.*.md` files currently retain upstream documentation; this English README describes lmplayer. See [LICENSE](LICENSE) for licensing.
