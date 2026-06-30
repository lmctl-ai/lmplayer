# Models, Variants & Effort (lmcode / github-copilot)

Key knowledge for building model-selection and effort CLI/commands. Verified against code.

## Two stacks (important)
- V1 (live runtime used by `run` CLI, TUI, /api): `packages/opencode/src/...` + `packages/core/src/v1/...`.
  Variants are rich provider-option objects (`reasoningEffort`, `thinking`, `effort`, `budgetTokens`...).
- V2 (new core): `packages/core/src/catalog.ts`, `session/runner/model.ts`, `packages/schema/src/model.ts`.
  Variants reduce to `{ id, headers, body }`.
- The github-copilot plugin emits the SDK-v2 Model type but with V1-style rich variant fields.
- The `run` CLI path is V1 — target that for CLI behavior.

## Model selection / default
- Config fields: `model` and `small_model` (string `provider/model`) — `packages/core/src/v1/config/config.ts:74-79`.
  There is NO top-level `variant`/`effort` config field.
- Parse `provider/model`: `packages/core/src/model.ts:33-39`; CLI inline `pick()` at `run.ts:31-38`.
- `run --model` overrides per-session/prompt (run.ts:165-169 -> session.create/prompt/command). Does NOT write config.
- Per-agent: `agent.<name>.model` + `agent.<name>.variant` — `packages/core/src/v1/config/agent.ts:14-17`.
  Agent `variant` only applies when resolved model == agent's configured model (prompt.ts:646-654).
- Default agent: config `default_agent` (config.ts:80-83).
- Resolution precedence (V1): explicit prompt model > agent.model > session current/default (prompt.ts:621-654).

## `models` command today
- `packages/opencode/src/cli/cmd/models.ts` (66 lines). `models [provider]` lists `providerID/modelID`.
  `--refresh` refreshes models.dev cache; `--verbose` dumps full model JSON. NO `--json` flag.
- Live entitled copilot list comes from the plugin fetching `<base>/models` with the token
  (`packages/opencode/src/plugin/github-copilot/models.ts:201-244`); keeps only "usable" models
  (policy not disabled, has limits + tool_calls). `model_picker_enabled` marks picker models.

## Variants = "effort" mechanism
- `run --variant <string>` (run.ts:212-219): free-form, validated against the model's variant keys.
  `--thinking` is DISPLAY-ONLY (shows reasoning blocks), does not change model behavior.
- Variant resolution priority (CLI): `--variant` flag > session history > saved preference.
  Saved per-model in state file `~/.local/state/lmcode/model.json` under `variant["provider/model"]`
  (`packages/opencode/src/cli/cmd/run/variant.shared.ts:18,96-187`). NOT a config file.
- Available variant/effort names for a model = `Object.keys(model.variants ?? {})`.
- How a variant reaches the request (V1): `session/llm/request.ts:80-91` deep-merges the variant
  options last; lowered to provider body by `core/src/v1/config/provider-options.ts`.

## Effort tiers (the "high / extra high" question)
- Master enumerator: `packages/opencode/src/provider/transform.ts` `variants(model)` at line ~665.
- Tier constants (transform.ts:517-525): widely-supported = `low, medium, high`.
  OpenAI = `none, minimal, low, medium, high, xhigh`. gpt-5.2+/codex add `xhigh`.
  Thinking-budget models = `high, max`. Anthropic adaptive adds `xhigh`, `max`.
- "EXTRA HIGH" = the wire value **`xhigh`** (there is no literal "extra high"). "max" exists for
  thinking-budget/anthropic-adaptive models.
- github-copilot efforts come from API `capabilities.supports.reasoning_effort` (usually low/medium/high),
  or `high`+`max` for thinking-budget models (models.ts:148-187). Copilot gpt-5.2+/codex get `xhigh`
  (transform.ts:819-843). Claude-on-copilot filters out `max`/`xhigh`.

## Setting a default effort (no clean top-level field exists)
Options: (a) `agent.<name>.variant` (config, applies only to that agent's model),
(b) state file `model.json` `variant["provider/model"]` (what run/TUI use), or
(c) `provider.<id>.models.<id>.request.variant` (config; V2 honors as model default).
Decision pending — see design tasks. Operator prefers config-file-based + a verify command.

## TUI runtime state a CLI replacement must cover (model.json)
Per-agent selected model, `recent[]`, `favorite[]`, and `variant` per model
(`packages/tui/src/context/local.tsx:134-402`). Reusable parser: `packages/opencode/src/acp/config-option.ts`
(`parseModelWithVariant`, `selectVariant`, `formatVariantName`).

## Verified live (this environment)
- Entitled copilot models (19): claude-haiku-4.5, claude-sonnet-4.6, claude-opus-4.7(/-fast),
  claude-opus-4.8(/-fast), gemini-2.5-pro, gpt-4o-mini(/-2024-07-18), gpt-4.1(/-2025-04-14),
  gpt-5-mini, gpt-5.2, gpt-5.2-codex, gpt-5.3-codex, gpt-5.4(/-mini/-nano), gpt-5.5.
- `lmcode models github-copilot --test` results (7 ok / 12 failed):
  - WORKING: gpt-4.1, gpt-4.1-2025-04-14, gpt-4o-mini(/-2024-07-18), gpt-5.3-codex, gpt-5.4, gemini-2.5-pro.
  - FAIL (404 "page not found"): ALL claude-* via copilot (haiku-4.5, sonnet-4.6, opus-4.7/-fast, opus-4.8/-fast).
  - FAIL ("model is not supported"): gpt-5.2, gpt-5.2-codex, gpt-5-mini, gpt-5.4-mini, gpt-5.4-nano, gpt-5.5 (entitled but not usable via this integrator).
- Default `~/.config/lmcode/opencode.jsonc`: `"model": "github-copilot/gpt-5.4"` (verified working).
- TODO: claude-via-copilot 404 — they route via `${url}/v1` + @ai-sdk/anthropic /v1/messages shim
  (models.ts:88-99). The 404 suggests a wrong endpoint path/base in the dev build. Worth investigating
  to unlock claude-opus-4.8 etc.
