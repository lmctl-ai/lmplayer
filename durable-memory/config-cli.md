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
- `Config.updateGlobal()` (config.ts:636): jsonc-preserving (uses `patchJsonc`, config.ts:149) + schema-validated.
  USE THIS for global set. For `.json` it deep-merges + re-validates.
- `patchJsonc(text, path[], value)` (config.ts:149): jsonc-parser `modify`; value `undefined` DELETES (use for unset).
- `Config.update()` (project, config.ts:623) is BROKEN for our use (writes config.json not opencode.json(c),
  no jsonc preservation). Do NOT use for `--project` until fixed.

## Precedence / shadowing (Reviewer3)
`get()` returns the fully merged effective config: global -> remote well-known -> console/org -> project ->
managed dir -> macOS managed prefs (override all) -> env flags. So a `set` to the global file can be shadowed.
`get`/`list` should read effective config; `set`/`unset` should warn when the target key is shadowed.
Arrays `disabled_providers`/`enabled_providers` are REPLACED by merge (need add/remove ops, not scalar set);
`instructions` is concatenated.

## Status / done
- DONE (commit 44046cee0): `config verify` command + shared `FormatConfigError` (readable errors at verify
  AND launch). Note: `verify` validates the EFFECTIVE post-bootstrap config (heavier; triggers instance init),
  not a pure file parse. `configSources()` currently reports GLOBAL candidates only (under-reports project/
  managed/remote provenance) — follow-up to derive from actually-loaded files.
- NEXT: `config get/set/unset` (global, jsonc-safe, schema-validated). Enables `config set model <id>` to
  switch model via CLI. `--project` deferred (writer broken).

## Effort default (decision)
No clean top-level config field for default effort exists. Primary mechanism = per-run `--effort/--variant`
flag, which the run path PERSISTS to state file `~/.local/state/lmcode/model.json` (variant per model) via
saveVariant. So "choose effort" sticks across runs without a config field. (See models-and-effort.md.)

## Non-interactive gaps (Reviewer3, for later)
- `providers login` has NO non-interactive API-key path (only Prompt.password) — blocker for unattended
  API-key providers. (Copilot uses OAuth device flow, already working.)
- `session` has no compact/share/rename/fork CLI. `mcp add` flag-path is global-only.
- `agent create` always calls the LLM (needs `--prompt`/`--prompt-file` to bypass).
