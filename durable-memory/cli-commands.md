# lmcode CLI — agent-facing commands (added in the agent-CLI work)

All runnable in dev as: `bun run --conditions=browser ./src/index.ts <cmd>` from packages/opencode
(PATH=/tmp/opencode/.bun/bin). Once the binary is renamed/installed: `lmcode <cmd>`.

## Discover models & entitlements
- `models [provider]` (and `models list [provider]`, alias `models ls`) `[--output file|-o file]` — list models (text), with direct file export.
- `models [provider] --search <query>` (aliases `-q`, `--query`) — filter models matching query substring in model ID, model name, or provider ID.
- `models [provider] --reasoning` (alias `-r`) — filter models supporting reasoning effort / thinking.
- `models [provider] --toolcall` (alias `--tools`) — filter models supporting tool calling.
- `models [provider] --attachment` (alias `--attachments`) — filter models supporting image and file attachments.
- `models [provider] --min-context <tokens>` — filter models with context window at least `<tokens>`.
- `models [provider] --json` — machine-readable array: {id, provider, name, limit, capabilities, variants[]}.
  `variants[]` are the reasoning-EFFORT choices for that model (low/medium/high/xhigh/max).
- `models show <model>` (alias `get`) `[--output file|-o file] [--json]` — inspect detailed configuration, limits, capabilities, reasoning-effort variants, and token pricing rates for a specific model, with direct file export.
- `models [provider] --refresh` — refresh models.dev cache.
- `models verify <model> [--effort <tier>] [--output file|-o file] [--json]` — verify a model is known and available (format, provider, auth, effort), with structured JSON output and file export.
- `models test [provider] [--output file|-o file] [--json] [--timeout ms] [--concurrency n]` — probe each entitled model with a single turn prompt, reporting OK/FAIL (exit non-zero on any fail), with direct file export. Also accepts `--test` flag on `models`.
- `auth list` (alias `providers list`, `providers ls`) `[--search q|-q q] [--all|-a] [--output file|-o file] [--json]` — authed providers (or all catalog providers with `--all`), each with its entitled model ids indented, search filtering, and file export.
- `auth list --json` (alias `providers list --json`) — {credentials_path, providers:[{id,name,type,source,authenticated,models:[{id,variants}]}]}.
  "Authed" = credentials in auth.json + active provider env vars (auth wins on overlap). Needs an instance.
- `auth show <provider>` (alias `providers show`, `auth get`, `providers get`) `[--output file|-o file] [--json]` — inspect detailed provider authentication status, active env vars, configuration options, entitled models, and direct file export.
- `auth logout [provider]` (alias `providers logout`) `[--force|-f] [--output file|-o file] [--json]` — log out from a configured provider with non-interactive guard, force flag, and structured JSON result.
- `providers enable <provider>` / `providers disable <provider>` (alias `provider enable/disable`) `[--scope project|global] [--project|-p] [--global|-g] [--output file|-o file] [--json]` — toggle provider enablement in project or global configuration, with structured JSON response and direct file export (`--output` / `-o`).

## Choose model + effort when prompting
- `run --model <provider/model> --effort <tier> "<prompt>"` — `--effort` is an alias of `--variant`.
  Effort tiers per model = the model's `variants` keys (see `models --json`). xhigh = "extra high".
- Non-interactive header now prints `> {agent} · {model} · {effort}`.

## Configure (editable file + CLI + verify)
- Global config file: `~/.config/lmcode/opencode.jsonc` (jsonc; comments preserved by writers).
- `config get [key] [--output file|-o file]` — effective value by dotted key (or whole config), with direct file export. Missing key -> exit 1.
- `config set <key> <value> [--json]` — write global config, jsonc-preserving, schema-validated
  (invalid write -> readable error, file unchanged). Value coercion: bool/number/json/string;
  `--json` parses value as JSON (subtree). e.g. `config set model github-copilot/gpt-5.4`.
- `config unset <key>` — delete a key (validate-before-write).
- `config list` (alias `ls`) `[--output file|-o file]` — list merged effective or scoped configuration, with direct file export.
- `config path [--scope project|global] [--project|-p] [--global|-g] [--output file|-o file] [--json]` — print resolved configuration file path(s) (project candidate in cwd, global config in `~/.config/lmplayer`, or active sources provenance), with direct file export.
- `config verify [--output file|-o file] [--json]` — validate effective config; prints "Config OK" + model/small_model/default_agent/default_variant (or writes report / outputs structured JSON with sources and defaults),
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
- `session ls [--limit n] [-n n] [--roots] [-a|--all] [--search q] [--output file|-o file] [--json]` / `session list [--max-count n] [--limit n] [-n n] [--roots] [-a|--all] [--search q] [--output file|-o file] [--format table|json]` — list active and recent sessions with server-side limit bounding and message fanout reduction, root-session filtering, cross-project global listing (`-a` / `--all`), title search, token/cost accounting in JSON payloads (`cost`, `tokens`, `created`), and direct file export (`--output`).
- `session show <id> [--output file|-o file] [--json]` (alias `get`) — inspect detailed session information including title, directory, parent ID, effective model/variant, agent, creation and update timestamps, message and turn counts (user, assistant, tool calls), token usage breakdown (input, output, reasoning, cache read/write), total cost, durable memory status, and public share URL, with direct file export (`--output`).
- `session status [id] [--output file|-o file] [--json]` — inspect live runtime status of a specific session (idle, busy, retry) or list all active/in-progress sessions across the instance with structured JSON output and direct file export (`--output`).
- `session tail <id> [--lines n] [-n n] [--limit n] [--output file|-o file] [--json]` — inspect recent session messages with verified session lookup, lines/limit bounding, structured JSON output containing message ID, role, text, timestamp, and assistant model/cost/tokens metadata, and direct file export (`--output`).
- `session report <id> [--output file|-o file] [--json]` — report session activity, tokens, text sizes, duration, and touched files, with direct file export (`--output`).
- `session metrics <id> [--output file|-o file] [--json]` — stable `session-metrics/v1` per-session machine-queryable metrics (tokens, write-time/persisted cost, latencies, tools, files, jobs, crons), with direct file export (`--output`).
- `session health <id> [--output file|-o file] [--threshold pct|-t pct] [--check] [--json]` — inspect session context usage and headroom against model limit, with direct file export (`--output`), configurable warning threshold (`--threshold`, default 80%), and threshold check (`--check`, exits with code 2 if context usage exceeds threshold).
- `session todo <id> [--status s] [--priority p] [--search q] [--output file|-o file] [--json]` — list todo tasks for a session with status checkboxes (`[x]`, `[>]`, `[-]`, `[ ]`) and priority tags, filtering by status (`--status`) and priority (`--priority`), text query search (`--search`), and direct file export (`--output`).
- `session diff <id> [--message msgID] [--file file|--path file] [--output file|-o file] [--stat] [--json]` — inspect file diffs and patches resulting from session turns, with file path filtering (`--file`), direct file export (`--output`), diffstat summary (`--stat`), and structured JSON output (`--json`).
- `session export [id] [--output file|-o file|--file file] [--sanitize] [--json]` — export session data as JSON to stdout or directly to a file, with optional sensitive transcript sanitization (`--sanitize`) and structured JSON summary (`--json`).
- `session import <file> [--title title] [--output file|-o file] [--json]` — import session data from a JSON file or share URL with fail-fast validation, optional title override (`--title`), direct file export (`--output` / `-o`), and structured JSON response (`--json`).
- `session jobs <id> [--output jobID|-o jobID] [--job jobID|-j jobID] [--status s|-s s] [--file file] [--json]` — list and inspect background jobs or untrusted job output, with direct file export (`--file`).
- `session crons <id> [--cron cronID] [--delete cronID] [--output file|-o file] [--json]` — list, inspect, and delete scheduled cron jobs, with direct file export (`--output`).
- `session rename <id> <title> [--output file|-o file] [--json]` — rename a session with structured JSON output and direct file export (`--output`).
- `session fork <id> [--title title|-t title] [--message msgID|-m msgID] [--output file|-o file] [--json]` — fork a session at a specific message boundary with an optional custom title (`--title`), structured JSON output, and direct file export (`--output`).
- `session share <id> [--unshare] [--output file|-o file] [--json]` / `session unshare <id> [--output file|-o file] [--json]` — create or revoke public share links, with structured JSON output and direct file export (`--output`).
- `session compact <id> [--model provider/model|-m model] [--auto] [--output file|-o file] [--json]` (alias `summarize`) — trigger session compaction/summarization with structured JSON output and direct file export (`--output`).
- `session delete <sessionID...> [extraSessionIDs...] [-f|--force] [--output file|-o file] [--json]` (alias `rm`) — delete one or more sessions and permanently remove their messages and history, with `--force` to ignore non-existent sessions, structured JSON response, and direct file export (`--output`).
- `session memory <id> [--output file|-o file] [--write <text>] [--append <text>] [--file <path>] [--clear] [--json]` (alias `brain`) — view, export (`--output`), update, append, or clear persistent durable memory for a session.

## Agent management
- `agent list` (alias `ls`) `[--search q|-q q] [--mode all|primary|subagent] [--native] [--output file|-o file] [--json]` — list all registered agents (built-in and custom) with mode, model, tool provision allowlists, query/mode/native filtering, and direct file export (`--output`).
- `agent show <name>` (alias `get`) `[--output file|-o file] [--json]` — inspect details of a specific agent (description, mode, model, variant, provision, system prompt, and permissions) with direct file export (`--output`).
- `agent create` `[--name n] [--prompt p] [--prompt-file f] [--provision t1,t2] [--path dir] [--output file|-o file] [--json]` — create a new custom agent with prompt-bypass or interactive wizard, structured JSON output (`--json`), and direct file export (`--output` / `-o`).
- `agent clone <source> <target> [--path dir] [--scope project|global] [--description d] [--model m] [-f|--force] [--output file|-o file] [--json]` (aliases: `copy`, `cp`) — clone an existing agent configuration (built-in or custom) into a new custom agent, preserving or overriding model, description, system prompt, tool provision allowlists, and permissions, with direct file export (`--output` / `-o`).
- `agent delete <name>` (alias `rm`) `[--force|-f] [--output file|-o file] [--json]` — safely delete a custom agent file or config entry; guards against deleting built-in agents (`build`, `plan`, `lean`, `summary`, `title`) with force and file export options.

## MCP management
- `mcp list` (alias `ls`) `[--search q|-q q] [--type local|remote|-t type] [--enabled] [--output file|-o file] [--json]` — list configured MCP servers and their connection statuses, with filtering by query/type/status and direct file export (`--output`).
- `mcp show <name>` (alias `get`) `[--output file|-o file] [--json]` — inspect details of a specific MCP server (type, status, enabled, url/command, args, cwd, headers, env, timeout, oauth) with direct file export (`--output`).
- `mcp add [name]` `[--url <url>] [--env <k=v>] [--header <k=v>] [--scope project|global] [--project|-p] [--global|-g] [--output file|-o file] [--json]` — interactive or non-interactive MCP server registration, with structured JSON output (`--json`) and direct file export (`--output` / `-o`).
- `mcp remove <name>` (alias `rm`) `[--scope project|global] [--project|-p] [--global|-g] [-f|--force] [--output file|-o file] [--json]` — remove an MCP server from configuration with JSONC formatting preservation, `--force` to guard missing servers, structured JSON response, and direct file export (`--output` / `-o`).
- `mcp enable <name>` / `mcp disable <name>` `[--scope project|global] [--project|-p] [--global|-g] [--output file|-o file] [--json]` — toggle MCP server enablement without losing configuration, with structured JSON response and direct file export (`--output` / `-o`).
- `mcp auth [name]` / `mcp auth list` (alias `ls`) `[--search q|-q q] [--status s|-s s] [--output file|-o file] [--json]` — list OAuth-capable servers and authenticate or inspect auth status with query/status filtering and direct file export (`--output`).
- `mcp logout [name]` `[--force|-f] [--output file|-o file] [--json]` — remove stored OAuth credentials for an MCP server with force flag, file export, and structured JSON output.
- `mcp debug <name>` — debug OAuth connection and test server info / tools.

## Token usage & statistics
- `stats [--days n] [--tools [n]] [--models [n]] [--project p] [--provider <id>] [--model <id>] [--budget <amount>] [--budget-check] [--output file|-o file] [--json]` — aggregate and inspect token usage, write-time costs, tool call counts, and daily/per-session averages across sessions. Supports granular provider (`--provider`) and model (`--model`) filtering for unmetered cloud ledgering (e.g. Ollama Cloud), client-side budget tracking (`--budget <amount>`), budget threshold checks (`--budget-check` which displays full stats and exits with code 2 if spend meets or exceeds the limit), direct file export (`--output file` / `-o file` for rendered table text or structured JSON), and machine-readable structured JSON output (`--json`).

## Database management & diagnostics
- `db path [--output file|-o file] [--json]` — print the active SQLite database path, with `--output` (`-o`) direct file export and `--json` returning structured path metadata (`path`, `wal`, `shm`).
- `db info` (aliases: `stats`, `status`) `[--output file|-o file] [--json]` — inspect SQLite database status, database file and WAL/SHM sizes, page sizes, page counts, freelist page counts, SQLite version, journal mode, and row counts across all tables, with `--output` (`-o`) direct file export for formatted reports and structured JSON.
- `db check` (aliases: `verify`, `integrity`) `[--output file|-o file] [--json]` — verify database integrity and foreign key constraints via `PRAGMA integrity_check` and `PRAGMA foreign_key_check`, reporting check results and failing with exit code 1 if issues or violations are detected, with `--output` (`-o`) direct file export.
- `db vacuum` (aliases: `optimize`, `clean`) `[--wal] [--analyze] [--output file|-o file] [--json]` — reclaim disk space and defragment database storage via `VACUUM` and `PRAGMA wal_checkpoint(TRUNCATE)`, run `PRAGMA optimize`, and optionally run query planner analysis (`--analyze`) or WAL checkpoint only (`--wal` / `--checkpoint`), reporting before/after byte sizes and reclaimed space, with `--output` (`-o`) direct file export.
- `db [query] [--format table|json|markdown]` — open an interactive `sqlite3` CLI shell or run raw SQL queries directly against the active database.

## Known gaps / TODO (not yet built)
- `models test [provider]` (probe each entitled model) — SHIPPED (with `--json`, `--timeout`, `--concurrency`).
- Persistent default effort relies on per-run `--effort` (persisted to model.json state), no config field. (CLOSED: added top-level `default_variant` and `variant` alias to ConfigV1.Info schema, prompt fallback, and config verify).
- Portal memory (external exposure of durable-memory) — SHIPPED via `session memory <id>` (alias `brain`) CLI command and `durable_memory` agent tool.
