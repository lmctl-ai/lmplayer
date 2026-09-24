# lmcode CLI — agent-facing commands (added in the agent-CLI work)

All runnable in dev as: `bun run --conditions=browser ./src/index.ts <cmd>` from packages/opencode
(PATH=/tmp/opencode/.bun/bin). Once the binary is renamed/installed: `lmcode <cmd>`.

## Discover models & entitlements
- `models [provider]` (and `models list [provider]`, alias `models ls`) `[--output file|-o file]` — list models (text), with direct file export.
- `models [provider] --search <query>` (aliases `-q`, `--query`) — filter models matching query substring in model ID, model name, or provider ID.
- `models [provider] --reasoning` (alias `-r`) — filter models supporting reasoning effort / thinking.
- `models [provider] --toolcall` (alias `--tools`) — filter models supporting tool calling.
- `models [provider] --attachment` (alias `--attachments`) — filter models supporting image and file attachments.
- `models [provider] --min-context <tokens>` (alias `--ctx`) — filter models with context window at least `<tokens>`.
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
- `auth logout [provider]` (alias `providers logout`) `[--provider p|-p p] [--force|-f] [--output file|-o file] [--json]` — log out from a configured provider with non-interactive guard, force flag, and structured JSON result.
- `providers enable <provider>` / `providers disable <provider>` (alias `provider enable/disable`) `[--scope project|global|-s scope] [--project|-p] [--global|-g] [--output file|-o file] [--json]` — toggle provider enablement in project or global configuration, with structured JSON response and direct file export (`--output` / `-o`).

## Choose model + effort when prompting
- `run [message..] [--model <provider/model>] [--effort <tier>] [--format default|json] [--json] [--output file|-o file] [--file <path>...] [--continue] [--session <id>] [--fork] [--share] [--title <text>]` — send prompt non-interactively, stream output, and write assistant output to file path (`--output` / `-o`), supporting clean markdown/text or structured JSON (`{ sessionID, text }` or raw events array with `--format json` or `--json`).
- `run --model <provider/model> --effort <tier> "<prompt>"` — `--effort` is an alias of `--variant`.
  Effort tiers per model = the model's `variants` keys (see `models --json`). xhigh = "extra high".
- Non-interactive header now prints `> {agent} · {model} · {effort}`.

## Configure (editable file + CLI + verify)
- Global config file: `~/.config/lmcode/opencode.jsonc` (jsonc; comments preserved by writers).
- `config get [key] [--scope project|global|-s scope] [--project|-p] [--global|-g] [--output file|-o file] [--json]` — effective value by dotted key (or whole config) as plain string or structured JSON, with direct file export (`--output` / `-o`). Missing key -> exit 1.
- `config set <key> <value> [--scope project|global|-s scope] [--project|-p] [--global|-g] [--output file|-o file] [--json]` — write project or global config, jsonc-preserving, schema-validated (invalid write -> readable error, file unchanged), with direct file export (`--output` / `-o`). Value coercion: bool/number/json/string; `--json` parses value as JSON (subtree). e.g. `config set model github-copilot/gpt-5.4`.
- `config unset <key> [--scope project|global|-s scope] [--project|-p] [--global|-g] [--output file|-o file] [--json]` — delete a key (validate-before-write), with structured JSON confirmation (`--json`) and direct file export (`--output` / `-o`).
- `config list` (alias `ls`) `[--scope project|global|-s scope] [--project|-p] [--global|-g] [--output file|-o file] [--json]` — list merged effective or scoped configuration, with direct file export (`--output` / `-o`) and `--json`.
- `config path [--scope project|global|-s scope] [--project|-p] [--global|-g] [--output file|-o file] [--json]` — print resolved configuration file path(s) (project candidate in cwd, global config in `~/.config/lmplayer`, or active sources provenance), with direct file export.
- `config verify [--output file|-o file] [--json]` — validate effective config; prints "Config OK" + model/small_model/default_agent/default_variant (or writes report / outputs structured JSON with sources and defaults),
  or readable issues (file + `dot.path: message`) with exit 1. Same readable error fails fast at launch.
- Dotted-key limitation: keys containing literal dots (some mcp names) need `--json` subtree set.

## Auth & providers
- `auth login [url] [--provider p|-p p] [--method m|-m m] [--key k|-k k] [--output file|-o file] [--json]` (OAuth device flow or API key; e.g. `auth login --provider github-copilot --method 'Login with GitHub Copilot'`). Supports direct file export (`--output` / `-o`) and structured JSON output (`--json`). Token -> ~/.local/share/lmcode/auth.json.

## Console & account management
- `console login [url]` (alias `account login`) `[--output file|-o file] [--json]` — log in to console server via OAuth device authorization, with direct file export (`--output` / `-o`) and structured JSON output (`--json`).
- `console logout [email]` (alias `account logout`) `[--force|-f] [--output file|-o file] [--json]` — log out from a console account with force guard, structured JSON confirmation, and direct file export (`--output` / `-o`).
- `console switch [org]` (alias `account switch`) `[--output file|-o file] [--json]` — switch active organization across console accounts, with non-interactive org identifier support, structured JSON response, and direct file export (`--output` / `-o`).
- `console orgs` (alias `account orgs`) `[--output file|-o file] [--json]` — list organizations across logged-in console accounts with active account and org indicator, with structured JSON output and direct file export (`--output` / `-o`).
- `console status` (aliases: `account status`, `console whoami`, `account whoami`) `[--output file|-o file] [--json]` — inspect active console account, server URL, and active organization status with structured JSON output (`authenticated`, `account`, `org`) and direct file export (`--output` / `-o`).
- `console open` (alias `account open`) `[--print|-p] [--output file|-o file] [--json]` — open active console URL in browser, or print URL directly without browser launch (`--print`), or export URL as text/JSON (`--output` / `-o`, `--json`).

## Server & Web interface
- `serve [--port n] [--hostname host] [--mdns] [--mdns-domain domain] [--cors origin...] [--output file|-o file] [--json]` — start headless lmplayer server with port/hostname/mDNS network options, structured JSON output (`url`, `hostname`, `port`), and direct file export (`--output` / `-o`).
- `web [--port n] [--hostname host] [--mdns] [--mdns-domain domain] [--cors origin...] [--no-open] [--output file|-o file] [--json]` — start lmplayer server and launch web interface (or bypass browser launch with `--no-open`), with structured JSON output (`url`, `hostname`, `port`, `localUrl`, `networkUrls`, `mdns`, `mdnsUrl`, `openedBrowser`) and direct file export (`--output` / `-o`).
- `attach <url> [--continue|-c] [--session|-s <id>] [--fork] [--dir <path>|--directory <path>|-d <path>] [--password|-p <pass>] [--username|-u <user>] [--mini] [--check] [--output file|-o file] [--json]` — attach to a running lmplayer server with TUI or mini interface, or validate server connectivity, authentication, and session existence without starting interactive interface (`--check`), with structured JSON output (`url`, `healthy`, `version`, `authenticated`, `directory`, `session`, `fork`, `continue`, `checkedAt`, `error`) and direct file export (`--output` / `-o`).
- `acp [--port n] [--hostname host] [--mdns] [--mdns-domain domain] [--cors origin...] [--cwd dir|--dir dir|--directory dir|-d dir] [--output file|-o file] [--json]` — start Agent Client Protocol (ACP) server communicating over stdio ndjson stream, with network options and file export writing server startup details (`url`, `hostname`, `port`, `cwd`, `client`, `pid`) directly to disk (`--output` / `-o`, `--json`) without polluting stdout.

## Installation, lifecycle & upgrades
- `upgrade [target] [--check|-c] [--method m] [--output file|-o file] [--json]` — upgrade lmplayer to the latest or specific version, or inspect upgrade availability without installing (`--check` / `-c`), reporting current version, latest version, target, method, and up-to-date status as machine-readable JSON or text with direct file export (`--output` / `-o`).
- `uninstall [--keep-config|-c] [--keep-data|-d] [--dry-run] [--force|-f] [--output file|-o file] [--json]` — uninstall lmplayer and related data, configuration, cache, state, binary, and shell hooks. In `--dry-run` mode, outputs structured manifest of target paths and byte sizes as JSON or formatted text, with direct file export (`--output` / `-o`). Non-interactive/JSON execution requires `--force` to guard against unintended data loss.

## Default command (DONE)
- `lmcode <message>` runs a non-interactive prompt (default `$0`). Piped stdin runs too
  (`echo hi | lmcode`). Bare `lmcode` on a TTY prints help. TUI is NOT default; use `lmcode tui`.
  Root `--mini` is unsupported (points to `lmcode tui` / `lmcode run --mini`).
- Binary renamed `opencode` -> `lmcode` (bin, build output, scriptName, Dockerfile). Dev wrapper at
  ~/.local/bin/lmcode runs from source. Platform package names (opencode-<plat>), publish.ts,
  postinstall.mjs, ASCII logo + "opencode" describe strings remain (branding follow-up).

## Session management
- `session ls [--limit n|-n n|--max-count n] [--roots] [-a|--all] [--search q|-q q] [--output file|-o file] [--json]` / `session list [--max-count n|--limit n|-n n] [--roots] [-a|--all] [--search q|-q q] [--output file|-o file] [--format table|json] [--json]` — list active and recent sessions with server-side limit bounding and message fanout reduction, root-session filtering, cross-project global listing (`-a` / `--all`), title search (`--search` / `-q`), token/cost accounting in JSON payloads (`cost`, `tokens`, `created`), and direct file export (`--output` / `-o`).
- `session show <id> [--output file|-o file] [--json]` (alias `get`) — inspect detailed session information including title, directory, parent ID, effective model/variant, agent, creation and update timestamps, message and turn counts (user, assistant, tool calls), token usage breakdown (input, output, reasoning, cache read/write), total cost, durable memory status, and public share URL, with direct file export (`--output` / `-o`).
- `session status [id] [--output file|-o file] [--json]` — inspect live runtime status of a specific session (idle, busy, retry) or list all active/in-progress sessions across the instance with structured JSON output and direct file export (`--output` / `-o`).
- `session tail <id> [--lines n] [-n n] [--limit n] [--output file|-o file] [--json]` — inspect recent session messages with verified session lookup, lines/limit bounding, structured JSON output containing message ID, role, text, timestamp, and assistant model/cost/tokens metadata, and direct file export (`--output` / `-o`).
- `session report <id> [--output file|-o file] [--json]` — report session activity, tokens, text sizes, duration, and touched files, with direct file export (`--output` / `-o`).
- `session metrics <id> [--output file|-o file] [--json]` — stable `session-metrics/v1` per-session machine-queryable metrics (tokens, write-time/persisted cost, latencies, tools, files, jobs, crons), with direct file export (`--output` / `-o`).
- `session health <id> [--output file|-o file] [--threshold pct|-t pct] [--check|-c] [--json]` — inspect session context usage and headroom against model limit, with direct file export (`--output` / `-o`), configurable warning threshold (`--threshold` / `-t`, default 80%), and threshold check (`--check` / `-c`, exits with code 2 if context usage exceeds threshold).
- `session todo <id> [--status s|-s s] [--priority p|-p p] [--search q|-q q] [--output file|-o file] [--json]` — list todo tasks for a session with status checkboxes (`[x]`, `[>]`, `[-]`, `[ ]`) and priority tags, filtering by status (`--status` / `-s`) and priority (`--priority` / `-p`), text query search (`--search` / `-q`), and direct file export (`--output` / `-o`).
- `session diff <id> [--message msgID|-m msgID] [--file file|--path file|-f file] [--output file|-o file] [--stat|-s] [--json]` — inspect file diffs and patches resulting from session turns, with file path filtering (`--file` / `--path` / `-f`), message filtering (`--message` / `-m`), diffstat summary (`--stat` / `-s`), direct file export (`--output` / `-o`), and structured JSON output (`--json`).
- `session export [id] [--output file|-o file|--file file] [--sanitize|-s] [--json]` — export session data as JSON to stdout or directly to a file, with optional sensitive transcript sanitization (`--sanitize` / `-s`) and structured JSON summary (`--json`).
- `session import <file> [--title title|-t title] [--output file|-o file] [--json]` — import session data from a JSON file or share URL with fail-fast validation, optional title override (`--title` / `-t`), direct file export (`--output` / `-o`), and structured JSON response (`--json`).
- `session jobs <id> [--output jobID|-o jobID] [--job jobID|-j jobID] [--status s|-s s] [--file file] [--json]` — list and inspect background jobs or untrusted job output, with direct file export (`--file`).
- `session crons <id> [--cron cronID|-c cronID] [--delete cronID|-d cronID] [--output file|-o file] [--json]` — list, inspect, and delete scheduled cron jobs, with direct file export (`--output` / `-o`).
- `session rename <id> <title> [--output file|-o file] [--json]` — rename a session with structured JSON output and direct file export (`--output` / `-o`).
- `session fork <id> [--title title|-t title] [--message msgID|-m msgID] [--output file|-o file] [--json]` — fork a session at a specific message boundary with an optional custom title (`--title` / `-t`), message boundary (`--message` / `-m`), structured JSON output, and direct file export (`--output` / `-o`).
- `session share <id> [--unshare] [--output file|-o file] [--json]` / `session unshare <id> [--output file|-o file] [--json]` — create or revoke public share links, with structured JSON output and direct file export (`--output` / `-o`).
- `session compact <id> [--model provider/model|-m model] [--auto] [--output file|-o file] [--json]` (alias `summarize`) — trigger session compaction/summarization with structured JSON output and direct file export (`--output` / `-o`).
- `session delete <sessionID...> [extraSessionIDs...] [-f|--force] [--output file|-o file] [--json]` (alias `rm`) — delete one or more sessions and permanently remove their messages and history, with `--force` / `-f` to ignore non-existent sessions, structured JSON response, and direct file export (`--output` / `-o`).
- `session memory <id> [--output file|-o file] [--write <text>|-w <text>] [--append <text>|-a <text>] [--file <path>|-f <path>] [--clear|-c] [--json]` (alias `brain`) — view, export (`--output` / `-o`), update (`--write` / `-w`), append (`--append` / `-a`), file load (`--file` / `-f`), or clear (`--clear` / `-c`) persistent durable memory for a session.

## Agent management
- `agent list` (alias `ls`) `[--search q|-q q] [--mode all|primary|subagent] [--native] [--output file|-o file] [--json]` — list all registered agents (built-in and custom) with mode, model, tool provision allowlists, query/mode/native filtering, and direct file export (`--output` / `-o`).
- `agent show <name>` (alias `get`) `[--output file|-o file] [--json]` — inspect details of a specific agent (description, mode, model, variant, provision, system prompt, and permissions) with direct file export (`--output` / `-o`).
- `agent create [--name n|-n n] [--prompt p|-p p] [--prompt-file f] [--description d|-d d] [--permissions perms|--perms perms|--tools perms] [--model m|-m m] [--provision t1,t2] [--path dir] [--mode all|primary|subagent] [--output file|-o file] [--json]` — create a new custom agent with prompt-bypass or interactive wizard, structured JSON output (`--json`), and direct file export (`--output` / `-o`).
- `agent clone <source> <target> [--path dir] [--scope project|global|-s scope] [--description d|-d d] [--model m|-m m] [--force|-f] [--output file|-o file] [--json]` (aliases: `copy`, `cp`) — clone an existing agent configuration (built-in or custom) into a new custom agent, preserving or overriding model, description, system prompt, tool provision allowlists, and permissions, with direct file export (`--output` / `-o`).
- `agent delete <name>` (alias `rm`) `[--force|-f] [--output file|-o file] [--json]` — safely delete a custom agent file or config entry; guards against deleting built-in agents (`build`, `plan`, `lean`, `summary`, `title`) with force and file export options (`--output` / `-o`).

## MCP management
- `mcp list` (alias `ls`) `[--search q|-q q] [--type local|remote|-t type] [--enabled] [--output file|-o file] [--json]` — list configured MCP servers and their connection statuses, with filtering by query/type/status and direct file export (`--output`).
- `mcp show <name>` (alias `get`) `[--output file|-o file] [--json]` — inspect details of a specific MCP server (type, status, enabled, url/command, args, cwd, headers, env, timeout, oauth) with direct file export (`--output`).
- `mcp add [name]` `[--url <url>] [--env <k=v>|--envs <k=v>] [--header <k=v>|--headers <k=v>|-H <k=v>] [--scope project|global] [--project|-p] [--global|-g] [--output file|-o file] [--json]` — interactive or non-interactive MCP server registration, with structured JSON output (`--json`) and direct file export (`--output` / `-o`).
- `mcp remove <name>` (alias `rm`) `[--scope project|global] [--project|-p] [--global|-g] [-f|--force] [--output file|-o file] [--json]` — remove an MCP server from configuration with JSONC formatting preservation, `--force` to guard missing servers, structured JSON response, and direct file export (`--output` / `-o`).
- `mcp enable <name>` / `mcp disable <name>` `[--scope project|global] [--project|-p] [--global|-g] [--output file|-o file] [--json]` — toggle MCP server enablement without losing configuration, with structured JSON response and direct file export (`--output` / `-o`).
- `mcp auth [name] [--output file|-o file] [--json]` — authenticate with an OAuth-enabled MCP server, supporting non-interactive credentials check, structured JSON result, and direct file export (`--output` / `-o`).
- `mcp auth list` (alias `ls`) `[--search q|-q q] [--status s|-s s] [--output file|-o file] [--json]` — list OAuth-capable servers and their authentication status with query/status filtering, structured JSON output (`--json`), and direct file export (`--output` / `-o`).
- `mcp logout [name]` `[--force|-f] [--output file|-o file] [--json]` — remove stored OAuth credentials for an MCP server with force flag, file export, and structured JSON output.
- `mcp debug <name> [--output file|-o file] [--json]` — debug OAuth connection, tokens, client ID registration, and HTTP/server status for an MCP server, with structured JSON output (`server`, `found`, `isRemote`, `oauthExplicitlyDisabled`, `authStatus`, `tokens`, `clientInfo`, `http`, `connectionSuccessful`, `oauthFlowTriggered`) and direct file export (`--output` / `-o`).

## Plugin installation & management
- `plugin <module>` (alias `plug`) `[--global|-g] [--force|-f] [--output file|-o file] [--json]` — install plugin package, detect server/tui targets, and update project or global configuration, with structured JSON response and direct file export (`--output` / `-o`).

## Token usage & statistics
- `stats [--days n|-d n] [--tools [n]] [--models [n]] [--project p|-p p] [--provider <id>] [--model <id>|-m <id>] [--budget <amount>|-b <amount>] [--budget-check] [--output file|-o file] [--json]` — aggregate and inspect token usage, write-time costs, tool call counts, and daily/per-session averages across sessions. Supports granular provider (`--provider`) and model (`--model` / `-m`) filtering for unmetered cloud ledgering (e.g. Ollama Cloud), client-side budget tracking (`--budget <amount>` / `-b <amount>`), budget threshold checks (`--budget-check` which displays full stats and exits with code 2 if spend meets or exceeds the limit), direct file export (`--output file` / `-o file` for rendered table text or structured JSON), and machine-readable structured JSON output (`--json`).

## Database management & diagnostics
- `db [query] [--format json|tsv] [--output file|-o file] [--json]` — execute an arbitrary SQL query on the active SQLite database in TSV or JSON format (or open an interactive sqlite3 shell if no query is given), with direct file export (`--output` / `-o`) and `--json`.
- `db path [--output file|-o file] [--json]` — print the active SQLite database path, with `--output` (`-o`) direct file export and `--json` returning structured path metadata (`path`, `wal`, `shm`).
- `db info` (aliases: `stats`, `status`) `[--output file|-o file] [--json]` — inspect SQLite database status, database file and WAL/SHM sizes, page sizes, page counts, freelist page counts, SQLite version, journal mode, and row counts across all tables, with `--output` (`-o`) direct file export for formatted reports and structured JSON.
- `db check` (aliases: `verify`, `integrity`) `[--output file|-o file] [--json]` — verify database integrity and foreign key constraints via `PRAGMA integrity_check` and `PRAGMA foreign_key_check`, reporting check results and failing with exit code 1 if issues or violations are detected, with `--output` (`-o`) direct file export.
- `db vacuum` (aliases: `optimize`, `clean`) `[--wal] [--analyze] [--output file|-o file] [--json]` — reclaim disk space and defragment database storage via `VACUUM` and `PRAGMA wal_checkpoint(TRUNCATE)`, run `PRAGMA optimize`, and optionally run query planner analysis (`--analyze`) or WAL checkpoint only (`--wal` / `--checkpoint`), reporting before/after byte sizes and reclaimed space, with `--output` (`-o`) direct file export.

## GitHub & Pull Request integration
- `pr <number> [--branch name|-b name] [--no-run] [--output file|-o file] [--json]` — fetch and checkout a GitHub PR branch, resolve fork remotes, auto-import associated sessions, and optionally launch lmplayer (or checkout only with `--no-run`), with structured JSON output (`pr`, `branch`, `checkedOut`, `forkRemote`, `session`, `sessionUrl`) and direct file export (`--output` / `-o`).
- `github install [--provider <id>|-p <id>] [--model <id>|-m <id>] [--dry-run] [--skip-app] [--force|-f] [--output file|-o file] [--json]` — install the GitHub agent workflow (`.github/workflows/opencode.yml`) in repository with provider and model selection, dry-run preview mode (`--dry-run`), GitHub App install/polling bypass (`--skip-app`), overwrite guard and force overwrite (`--force` / `-f`), structured JSON output (`--json`), and direct file export (`--output` / `-o`).
- `github run [--event event|-e event] [--token token|-t token] [--output file|-o file] [--json]` — run GitHub agent against event context or mock payload, with run summary file export (`--output` / `-o`) and structured JSON output (`--json`).

## Container orchestration & failover
- `orchestrator status [--registry file|-r file] [--output file|-o file] [--json]` — health-check registered containers and show the durable assignment map with container IDs, URLs, and epochs, with direct file export (`--output` / `-o`) and structured JSON.
- `orchestrator handover --session id|-s id --from id|-f id --to id|-t id [--tail n|-n n] [--registry file|-r file] [--output file|-o file] [--json]` — move a session between containers via export/import bundle transfer with monotonic epoch bumping and direct file export (`--output` / `-o`).
- `orchestrator refresh --to id|-t id [--registry file|-r file] [--output file|-o file] [--json]` — gracefully drain and shut down a container after its in-flight run completes, with direct file export (`--output` / `-o`).
- `orchestrator assign --session id|-s id --to id|-t id [--registry file|-r file] [--output file|-o file] [--json]` — record or update a session's home container in the durable assignment map without moving data, with direct file export (`--output` / `-o`).

## Diagnostics, debugging & OpenAPI generation
- `debug paths [--output file|-o file] [--json]` — inspect global application paths (data, config, state, cache, log, bin), with structured JSON output and direct file export (`--output` / `-o`).
- `debug info [--output file|-o file] [--json]` — inspect runtime installation version, OS platform/architecture, terminal, and loaded plugins, with structured JSON output and direct file export (`--output` / `-o`).
- `debug config [--output file|-o file] [--json]` — inspect fully resolved configuration JSON, with direct file export (`--output` / `-o`) and `--json`.
- `debug skill [--output file|-o file] [--json]` — inspect all discovered and loaded skills JSON, with direct file export (`--output` / `-o`) and `--json`.
- `debug v2 [--output file|-o file] [--json]` — inspect v2 catalog providers and default/small models JSON, with direct file export (`--output` / `-o`) and `--json`.
- `debug scrap [--output file|-o file] [--json]` — list all registered and active projects JSON, with direct file export (`--output` / `-o`) and `--json`.
- `debug file search <query> [--output file|-o file] [--json]` / `debug file read <path> [--output file|-o file] [--json]` / `debug file list <path> [--output file|-o file] [--json]` — query, read, and list files across workspace location services with direct file export (`--output` / `-o`) and `--json`.
- `debug rg files [--query q] [--glob g] [--limit n] [--output file|-o file] [--json]` / `debug rg search <pattern> [--glob g] [--limit n] [--output file|-o file] [--json]` — ripgrep fast file finding and pattern search across instance worktree, with direct file export (`--output` / `-o`) and structured JSON (`--json`).
- `debug snapshot track [--output file|-o file] [--json]` / `debug snapshot patch <hash> [--output file|-o file] [--json]` / `debug snapshot diff <hash> [--output file|-o file] [--json]` — inspect worktree snapshot tracking, commit patches, and state diffs with direct file export (`--output` / `-o`) and structured JSON (`--json`).
- `debug lsp diagnostics <file> [--output file|-o file] [--json]` / `debug lsp symbols <query> [--output file|-o file] [--json]` / `debug lsp document-symbols <uri> [--output file|-o file] [--json]` — query workspace LSP diagnostics and symbol indexes with direct file export (`--output` / `-o`) and structured JSON (`--json`).
- `debug startup [--output file|-o file] [--json]` — print application startup timing with structured JSON and direct file export (`--output` / `-o`).
- `debug agent <name> [--tool toolId] [--params json] [--output file|-o file] [--json]` — inspect agent configuration, permissions, and tool capabilities or execute tools directly with file export (`--output` / `-o`) and `--json`.
- `generate [--output file|-o file] [--json]` — generate OpenAPI schema for the lmplayer server with JavaScript SDK code samples and prettier formatting, with direct file export (`--output` / `-o`) and machine-readable JSON write confirmation (`--json`).

## Known gaps / TODO (not yet built)
- `models test [provider]` (probe each entitled model) — SHIPPED (with `--json`, `--timeout`, `--concurrency`).
- Persistent default effort relies on per-run `--effort` (persisted to model.json state), no config field. (CLOSED: added top-level `default_variant` and `variant` alias to ConfigV1.Info schema, prompt fallback, and config verify).
- Portal memory (external exposure of durable-memory) — SHIPPED via `session memory <id>` (alias `brain`) CLI command and `durable_memory` agent tool.
