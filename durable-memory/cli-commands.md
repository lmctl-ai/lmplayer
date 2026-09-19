# lmcode CLI — agent-facing commands (added in the agent-CLI work)

All runnable in dev as: `bun run --conditions=browser ./src/index.ts <cmd>` from packages/opencode
(PATH=/tmp/opencode/.bun/bin). Once the binary is renamed/installed: `lmcode <cmd>`.

## Discover models & entitlements
- `models [provider]` (and `models list [provider]`, alias `models ls`) — list models (text).
- `models [provider] --search <query>` (aliases `-q`, `--query`) — filter models matching query substring in model ID, model name, or provider ID.
- `models [provider] --reasoning` (alias `-r`) — filter models supporting reasoning effort / thinking.
- `models [provider] --toolcall` (alias `--tools`) — filter models supporting tool calling.
- `models [provider] --attachment` (alias `--attachments`) — filter models supporting image and file attachments.
- `models [provider] --min-context <tokens>` — filter models with context window at least `<tokens>`.
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
- `session ls [--limit n] [-n n] [--roots] [-a|--all] [--search q] [--json]` / `session list [--max-count n] [--limit n] [-n n] [--roots] [-a|--all] [--search q] [--format table|json]` — list active and recent sessions with server-side limit bounding and message fanout reduction, root-session filtering, cross-project global listing (`-a` / `--all`), title search, and token/cost accounting in JSON payloads (`cost`, `tokens`, `created`).
- `session show <id> [--json]` (alias `get`) — inspect detailed session information including title, directory, parent ID, effective model/variant, agent, creation and update timestamps, message and turn counts (user, assistant, tool calls), token usage breakdown (input, output, reasoning, cache read/write), total cost, durable memory status, and public share URL.
- `session status [id] [--json]` — inspect live runtime status of a specific session (idle, busy, retry) or list all active/in-progress sessions across the instance with structured JSON output.
- `session tail <id> [--lines n] [-n n] [--limit n] [--json]` — inspect recent session messages with verified session lookup, lines/limit bounding, and structured JSON output containing message ID, role, text, timestamp, and assistant model/cost/tokens metadata.
- `session report <id> [--output file|-o file] [--json]` — report session activity, tokens, text sizes, duration, and touched files, with direct file export (`--output`).
- `session metrics <id> [--output file|-o file] [--json]` — stable `session-metrics/v1` per-session machine-queryable metrics (tokens, write-time/persisted cost, latencies, tools, files, jobs, crons), with direct file export (`--output`).
- `session health <id> [--output file|-o file] [--threshold pct|-t pct] [--check] [--json]` — inspect session context usage and headroom against model limit, with direct file export (`--output`), configurable warning threshold (`--threshold`, default 80%), and threshold check (`--check`, exits with code 2 if context usage exceeds threshold).
- `session todo <id> [--status s] [--priority p] [--search q] [--output file|-o file] [--json]` — list todo tasks for a session with status checkboxes (`[x]`, `[>]`, `[-]`, `[ ]`) and priority tags, filtering by status (`--status`) and priority (`--priority`), text query search (`--search`), and direct file export (`--output`).
- `session diff <id> [--message msgID] [--file file|--path file] [--output file|-o file] [--stat] [--json]` — inspect file diffs and patches resulting from session turns, with file path filtering (`--file`), direct file export (`--output`), diffstat summary (`--stat`), and structured JSON output (`--json`).
- `session export [id] [--output file|-o file|--file file] [--sanitize] [--json]` — export session data as JSON to stdout or directly to a file, with optional sensitive transcript sanitization (`--sanitize`) and structured JSON summary (`--json`).
- `session import <file> [--title title] [--json]` — import session data from a JSON file or share URL with fail-fast validation, optional title override (`--title`), and structured JSON response (`--json`).
- `session jobs <id> [--json] [--output jobID] [--job jobID] [--status s]` — list and inspect background jobs.
- `session crons <id> [--json] [--cron cronID] [--delete cronID]` — list, inspect, and delete scheduled cron jobs.
- `session rename <id> <title> [--json]` — rename a session.
- `session fork <id> [--title title|-t title] [--message msgID] [--json]` — fork a session at a specific message boundary with an optional custom title (`--title`).
- `session share <id> [--unshare] [--json]` / `session unshare <id> [--json]` — create or revoke public share links.
- `session compact <id> [--model provider/model] [--auto] [--json]` (alias `summarize`) — trigger session compaction/summarization.
- `session delete <sessionID...> [extraSessionIDs...] [-f|--force] [--json]` (alias `rm`) — delete one or more sessions and permanently remove their messages and history, with `--force` to ignore non-existent sessions and `--json` structured response.
- `session memory <id> [--output file|-o file] [--write <text>] [--append <text>] [--file <path>] [--clear] [--json]` (alias `brain`) — view, export (`--output`), update, append, or clear persistent durable memory for a session.

## Agent management
- `agent list` (alias `ls`) `[--json] [--mode all|primary|subagent]` — list all registered agents (built-in and custom) with their mode, model, and tool provision allowlists, sorted with built-ins first.
- `agent show <name>` (alias `get`) `[--json]` — inspect details of a specific agent (description, mode, model, variant, provision, system prompt, and permissions).
- `agent create` `[--name n] [--prompt p] [--prompt-file f] [--provision t1,t2] [--path dir] [--json]` — create a new custom agent with prompt-bypass or interactive wizard.
- `agent clone <source> <target> [--path dir] [--scope project|global] [--description d] [--model m] [-f|--force] [--json]` (aliases: `copy`, `cp`) — clone an existing agent configuration (built-in or custom) into a new custom agent, preserving or overriding model, description, system prompt, tool provision allowlists, and permissions.
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
- `stats [--days n] [--tools [n]] [--models [n]] [--project p] [--provider <id>] [--model <id>] [--budget <amount>] [--budget-check] [--json]` — aggregate and inspect token usage, write-time costs, tool call counts, and daily/per-session averages across sessions. Supports granular provider (`--provider`) and model (`--model`) filtering for unmetered cloud ledgering (e.g. Ollama Cloud), client-side budget tracking (`--budget <amount>`), budget threshold checks (`--budget-check` which displays full stats and exits with code 2 if spend meets or exceeds the limit), and machine-readable structured JSON output (`--json`).

## Database management & diagnostics
- `db path [--json]` — print the active SQLite database path, with `--json` returning structured path metadata (`path`, `wal_path`, `shm_path`).
- `db info` (aliases: `stats`, `status`) `[--json]` — inspect SQLite database status, database file and WAL/SHM sizes, page sizes, page counts, freelist page counts, SQLite version, journal mode, and row counts across all tables.
- `db check` (aliases: `verify`, `integrity`) `[--json]` — verify database integrity and foreign key constraints via `PRAGMA integrity_check` and `PRAGMA foreign_key_check`, reporting structured check results and failing with exit code 1 if issues or violations are detected.
- `db vacuum` (aliases: `optimize`, `clean`) `[--wal] [--analyze] [--json]` — reclaim disk space and defragment database storage via `VACUUM` and `PRAGMA wal_checkpoint(TRUNCATE)`, run `PRAGMA optimize`, and optionally run query planner analysis (`--analyze`) or WAL checkpoint only (`--wal` / `--checkpoint`), reporting before/after byte sizes and reclaimed space.
- `db [query] [--format table|json|markdown]` — open an interactive `sqlite3` CLI shell or run raw SQL queries directly against the active database.

## Known gaps / TODO (not yet built)
- `models test [provider]` (probe each entitled model) — SHIPPED (with `--json`, `--timeout`, `--concurrency`).
- Persistent default effort relies on per-run `--effort` (persisted to model.json state), no config field. (CLOSED: added top-level `default_variant` and `variant` alias to ConfigV1.Info schema, prompt fallback, and config verify).
- Portal memory (external exposure of durable-memory) — SHIPPED via `session memory <id>` (alias `brain`) CLI command and `durable_memory` agent tool.
