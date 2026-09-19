# lmcode CLI — agent-facing commands (added in the agent-CLI work)

All runnable in dev as: `bun run --conditions=browser ./src/index.ts <cmd>` from packages/opencode
(PATH=/tmp/opencode/.bun/bin). Once the binary is renamed/installed: `lmcode <cmd>`.

## Discover models & entitlements
- `models [provider]` — list models (text).
- `models [provider] --json` — machine-readable array: {id, provider, name, limit, capabilities, variants[]}.
  `variants[]` are the reasoning-EFFORT choices for that model (low/medium/high/xhigh/max).
- `models show <model>` (alias `get`) `[--json]` — inspect detailed configuration, limits, capabilities, reasoning-effort variants, and token pricing rates for a specific model.
- `models [provider] --refresh` — refresh models.dev cache.
- `models verify <model>` — verify a model is known and available (format, provider, auth, effort).
- `models test [provider] [--json] [--timeout ms] [--concurrency n]` — probe each entitled model with a single turn prompt, reporting OK/FAIL (exit non-zero on any fail). Also accepts `--test` flag on `models`.
- `auth list` (alias `providers list`, `providers ls`) — authed providers, each with its entitled model ids indented.
- `auth list --json` (alias `providers list --json`) — {credentials_path, providers:[{id,name,type,source,models:[{id,variants}]}]}.
  "Authed" = credentials in auth.json + active provider env vars (auth wins on overlap). Needs an instance.
- `auth show <provider>` (alias `providers show`, `auth get`, `providers get`) `[--json]` — inspect detailed provider authentication status, active env vars, configuration options, and entitled models.

## Choose model + effort when prompting
- `run --model <provider/model> --effort <tier> "<prompt>"` — `--effort` is an alias of `--variant`.
  Effort tiers per model = the model's `variants` keys (see `models --json`). xhigh = "extra high".
- Non-interactive header now prints `> {agent} · {model} · {effort}`.

## Configure (editable file + CLI + verify)
- Global config file: `~/.config/lmcode/opencode.jsonc` (jsonc; comments preserved by writers).
- `config get [key]` — effective value by dotted key (or whole config). Missing key -> exit 1.
- `config set <key> <value> [--json]` — write global config, jsonc-preserving, schema-validated
  (invalid write -> readable error, file unchanged). Value coercion: bool/number/json/string;
  `--json` parses value as JSON (subtree). e.g. `config set model github-copilot/gpt-5.4`.
- `config unset <key>` — delete a key (validate-before-write).
- `config list` (alias `ls`) — list merged effective or scoped configuration.
- `config path [--scope project|global] [--project|-p] [--global|-g] [--json]` — print resolved configuration file path(s) (project candidate in cwd, global config in `~/.config/lmplayer`, or active sources provenance).
- `config verify` — validate effective config; prints "Config OK" + model/small_model/default_agent/default_variant,
  or readable issues (file + `dot.path: message`) with exit 1. Same readable error fails fast at launch.
- Dotted-key limitation: keys containing literal dots (some mcp names) need `--json` subtree set.

## Auth (github-copilot)
- `auth login --provider github-copilot --method 'Login with GitHub Copilot'` (OAuth device flow;
  poll loop fixed to wait through HTTP-400 authorization_pending). Token -> ~/.local/share/lmcode/auth.json.

## Default command (DONE)
- `lmcode <message>` runs a non-interactive prompt (default `$0`). Piped stdin runs too
  (`echo hi | lmcode`). Bare `lmcode` on a TTY prints help. TUI is NOT default; use `lmcode tui`.
  Root `--mini` is unsupported (points to `lmcode tui` / `lmcode run --mini`).
- Binary renamed `opencode` -> `lmcode` (bin, build output, scriptName, Dockerfile). Dev wrapper at
  ~/.local/bin/lmcode runs from source. Platform package names (opencode-<plat>), publish.ts,
  postinstall.mjs, ASCII logo + "opencode" describe strings remain (branding follow-up).

## Session management
- `session ls [--limit n] [-n n] [--roots] [--search q] [--json]` / `session list [--max-count n] [--limit n] [-n n] [--roots] [--search q] [--format table|json]` — list active and recent sessions with server-side limit bounding and message fanout reduction, root-session filtering, and title search.
- `session tail <id> [--lines n] [--format text|json]` — tail/stream messages from a session.
- `session report <id> [--json]` — report session activity, tokens, text sizes, duration, and touched files.
- `session metrics <id> [--json]` — stable `session-metrics/v1` per-session machine-queryable metrics (tokens, write-time/persisted cost, latencies, tools, files, jobs, crons).
- `session health <id> [--json]` — inspect session context usage and headroom against model limit.
- `session todo <id> [--json]` — list todo tasks for a session with status checkboxes (`[x]`, `[>]`, `[-]`, `[ ]`) and priority tags.
- `session diff <id> [--message msgID] [--stat] [--json]` — inspect file diffs and patches resulting from session turns, with optional diffstat summary (`--stat`).
- `session export [id] [--sanitize]` — export session data as JSON with optional sensitive transcript sanitization.
- `session import <file>` — import session data from a file or share URL.
- `session jobs <id> [--json] [--output jobID] [--job jobID] [--status s]` — list and inspect background jobs.
- `session crons <id> [--json] [--cron cronID] [--delete cronID]` — list, inspect, and delete scheduled cron jobs.
- `session rename <id> <title> [--json]` — rename a session.
- `session fork <id> [--message msgID] [--json]` — fork a session at a specific message boundary.
- `session share <id> [--unshare] [--json]` / `session unshare <id> [--json]` — create or revoke public share links.
- `session compact <id> [--model provider/model] [--auto] [--json]` (alias `summarize`) — trigger session compaction/summarization.
- `session delete <id>` — delete a session and all its messages and parts.
- `session memory <id> [--json] [--write <text>] [--append <text>] [--file <path>] [--clear]` (alias `brain`) — view, update, append, or clear persistent durable memory for a session.

## Agent management
- `agent list` (alias `ls`) `[--json] [--mode all|primary|subagent]` — list all registered agents (built-in and custom) with their mode, model, and tool provision allowlists, sorted with built-ins first.
- `agent show <name>` (alias `get`) `[--json]` — inspect details of a specific agent (description, mode, model, variant, provision, system prompt, and permissions).
- `agent create` `[--name n] [--prompt p] [--prompt-file f] [--provision t1,t2] [--path dir] [--json]` — create a new custom agent with prompt-bypass or interactive wizard.
- `agent delete <name>` (alias `rm`) `[--json]` — safely delete a custom agent file or config entry; guards against deleting built-in agents (`build`, `plan`, `lean`, `summary`, `title`).

## MCP management
- `mcp list` (alias `ls`) `[--json]` — list configured MCP servers and their connection statuses (with JSON structured output).
- `mcp show <name>` (alias `get`) `[--json]` — inspect details of a specific MCP server (type, status, enabled, url/command, args, cwd, headers, env, timeout, oauth).
- `mcp add [name]` — interactive or non-interactive (`--url`, `--header`, `--env`, `--project`, `--global`) MCP server registration.
- `mcp remove <name>` (alias `rm`) `[--scope project|global] [--project|-p] [--global|-g]` — remove an MCP server from configuration with JSONC formatting preservation.
- `mcp enable <name>` / `mcp disable <name>` `[--scope project|global] [--project|-p] [--global|-g]` — toggle MCP server enablement without losing configuration.
- `mcp auth [name]` / `mcp auth list` (alias `ls`) `[--json]` — list OAuth-capable servers and authenticate or inspect auth status.
- `mcp logout [name]` — remove stored OAuth credentials for an MCP server.
- `mcp debug <name>` — debug OAuth connection and test server info / tools.

## Token usage & statistics
- `stats [--days n] [--tools [n]] [--models [n]] [--project p] [--provider <id>] [--model <id>] [--json]` — aggregate and inspect token usage, write-time costs, tool call counts, and daily/per-session averages across sessions. Supports granular provider (`--provider`) and model (`--model`) filtering for unmetered cloud ledgering (e.g. Ollama Cloud) and machine-readable structured JSON output (`--json`).

## Known gaps / TODO (not yet built)
- `models test [provider]` (probe each entitled model) — SHIPPED (with `--json`, `--timeout`, `--concurrency`).
- Persistent default effort relies on per-run `--effort` (persisted to model.json state), no config field. (CLOSED: added top-level `default_variant` and `variant` alias to ConfigV1.Info schema, prompt fallback, and config verify).
- Portal memory (external exposure of durable-memory) — SHIPPED via `session memory <id>` (alias `brain`) CLI command and `durable_memory` agent tool.
