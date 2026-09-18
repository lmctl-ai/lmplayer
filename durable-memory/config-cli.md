# Config CLI (lmcode)

Goal: an LLM/agent configures lmcode via CLI commands AND editable config files, with a verify step.

## Config model (recap)
- Main schema: `ConfigV1.Info` (`packages/core/src/v1/config/config.ts`). Key fields agents care about:
  `model`, `small_model`, `default_agent`, `agent.*`, `provider.*`, `disabled_providers`,
  `enabled_providers`, `mcp.*`, `permission`, `tools`, `compaction.*`, `share`, `autoupdate`,
  `instructions`, `formatter`, `lsp`, `experimental.*`.
- `theme`/`keybinds`/`tui` are stripped at load (`normalizeLoadedConfig`, config.ts:53-62) — TUI-only, drop.
- Global config dir: `~/.config/lmcode/` files `opencode.jsonc` | `opencode.json` | `config.json`.
- Loader validates via `ConfigParse.schema(ConfigV1.Info, ...)` -> throws structured InvalidError/JsonError.

## Writers (existing machinery)
- `Config.updateGlobal()` (config.ts): jsonc-preserving (uses `patchJsonc`) + schema-validated.
  Writes global config; for `.json` it deep-merges + re-validates.
- `Config.updateProject()` (config.ts): jsonc-preserving + schema-validated.
  Writes project config (`opencode.json`, `opencode.jsonc`, `.opencode/opencode.json`); auto-creates directory if needed and invalidates instance cache.
- `Config.unsetGlobal()` / `Config.unsetProject()` (config.ts): dotted path segment removal via `patchJsonc(input, undefined, segments)` in jsonc and deletePath in json, re-validating before writing.
- `patchJsonc(text, path[], value)` (config.ts): jsonc-parser `modify`; value `undefined` DELETES.

## Precedence / shadowing (Reviewer3)
`get()` returns the fully merged effective config: global -> remote well-known -> console/org -> project ->
managed dir -> macOS managed prefs (override all) -> env flags. So a `set` to the global file can be shadowed.
`get` reads effective config by default, or project/global with `--project`/`--global`; `set`/`unset` warn on `stderr` when the target key is shadowed by higher-precedence configuration.
Arrays `disabled_providers`/`enabled_providers` are REPLACED by merge (need add/remove ops, not scalar set);
`instructions` is concatenated.

## Status / done
- DONE (commit 44046cee0): `config verify` command + shared `FormatConfigError` (readable errors at verify
  AND launch). Note: `verify` validates the EFFECTIVE post-bootstrap config (heavier; triggers instance init),
  not a pure file parse. `configSources()` reports both global and project candidate provenance.
- DONE: `config get/set/unset` with full `--scope <project|global>`, `--project` (`-p`), and `--global` (`-g`) support.
  Preserves JSONC comments, validates against schema before writing, warns on `stderr` when keys are shadowed, and invalidates in-memory instance caches. Full test suite in `packages/opencode/test/cli/config.test.ts`.
- DONE: `config list` (alias `ls`) and `config path` commands. `config path` resolves project config in cwd, global config in `~/.config/lmplayer`, or active provenance sources (`--project`, `--global`, `--json`).

## Effort default (decision)
No clean top-level config field for default effort exists. Primary mechanism = per-run `--effort/--variant`
flag, which the run path PERSISTS to state file `~/.local/state/lmcode/model.json` (variant per model) via
saveVariant. So "choose effort" sticks across runs without a config field. (See models-and-effort.md.)

## Non-interactive gaps (Reviewer3, for later)
- `providers login` / `auth login`: RESOLVED — non-interactive API-key path added via `--key` / `--api-key` / `-k <key>`, `--key -` (stdin), and piped non-TTY stdin fallback.
- `agent create`: RESOLVED — added `--prompt`, `--prompt-file`, `--name`, and `--provision` to bypass LLM generation and enable fully deterministic, non-interactive agent creation.
- `session`: RESOLVED — added `session rename <sessionID> <title>`, `session fork <sessionID> [--message <id>]`, `session share <sessionID> [--unshare]`, `session unshare <sessionID>`, and `session compact <sessionID> [--model <model>] [--auto]` (with alias `summarize`). All session commands route via `localSdk()` to honor server workspace routing and HTTP routers.
- `mcp add`: RESOLVED — added `--scope <project|global>`, `--project` (`-p`), and `--global` (`-g`) flags with support for `.opencode/opencode.json` and root `opencode.json` project configuration.
