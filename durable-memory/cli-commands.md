# lmcode CLI — agent-facing commands (added in the agent-CLI work)

All runnable in dev as: `bun run --conditions=browser ./src/index.ts <cmd>` from packages/opencode
(PATH=/tmp/opencode/.bun/bin). Once the binary is renamed/installed: `lmcode <cmd>`.

## Discover models & entitlements
- `models [provider]` — list models (text).
- `models [provider] --json` — machine-readable array: {id, provider, name, limit, capabilities, variants[]}.
  `variants[]` are the reasoning-EFFORT choices for that model (low/medium/high/xhigh/max).
- `models [provider] --refresh` — refresh models.dev cache.
- `auth list` (alias `providers list`) — authed providers, each with its entitled model ids indented.
- `auth list --json` — {credentials_path, providers:[{id,name,type,source,models:[{id,variants}]}]}.
  "Authed" = credentials in auth.json + active provider env vars (auth wins on overlap). Needs an instance.

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
- `config verify` — validate effective config; prints "Config OK" + model/small_model/default_agent,
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

## Known gaps / TODO (not yet built)
- `models test` (probe each entitled model) — IN PROGRESS. Claude-via-copilot 404s in dev build.
- Persistent default effort relies on per-run `--effort` (persisted to model.json state), no config field.
- Portal memory (external exposure of durable-memory) — pending.
