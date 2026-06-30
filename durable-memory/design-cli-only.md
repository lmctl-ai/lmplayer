# Design: lmcode as a plain agent CLI (remove TUI, CLI-settable config, no batch timeout)

Status: REVISED per operator. Author: Lead.

## REVISED SCOPE (operator clarification — supersedes the broader plan below)
Do NOT remove the TUI. Just stop defaulting to it. Three concrete asks:
1. DEFAULT = send command (batch/run). `lmcode "<prompt>"` runs a non-interactive batch.
   Keep the TUI reachable via an explicit `lmcode tui` subcommand (today the TUI is ONLY `$0`).
2. REMOVE the hard 5-minute timeout so autonomous agent runs can go for days/weeks.
   CORRECTION (Lead, after Reviewer1 review): my initial root cause (Node http requestTimeout) was WRONG.
   Facts established:
   - Default local `opencode run` is IN-PROCESS via `Server.Default().app.fetch` (run.ts:926-939) — no
     sockets, no Node listener, so server-level timeouts (requestTimeout) do NOT apply to it.
   - Even on the serve/attach listener path, Node `requestTimeout` bounds request RECEIPT (small body,
     instant), not the long response; `server.timeout` defaults to 0 (disabled). So neither bounds a long run.
   - The model-request path (aisdk.ts:90 / provider.ts:1720) only applies a timeout when
     `provider.<id>.options.timeout` is set; default is unset = unbounded.
   - The only "5 min / 300000" in the codebase is STALE generated doc at sdk/js/src/gen/types.gen.ts:1094.
   CONCLUSION: current code applies NO 5-minute default. The operator's observed cutoff must come from
   one of: (a) a `timeout` in their provider config (opencode.json), (b) model.api.settings/request.body
   timeout injected by the runtime model catalog, (c) the github-copilot endpoint / network, or
   (d) the lmctl harness wrapping the member run (idle-timeout), or (e) they run via serve/attach + a Bun
   `idleTimeout` (~10s default, max 255s — but that's not 5 min). MUST get the operator's exact invocation
   + the error seen at 5 min before changing anything. Task B is BLOCKED pending that.
3. CONFIG = a defined, user-editable config file + a VERIFY step before the app launches.
   Schema already exists (ConfigV1.Info). Add `lmcode config verify` (load + schema-validate +
   readable errors) and validate-on-launch (fail fast with a clear message instead of an obscure die).
   This REPLACES the larger config get/set/setters plan below (not needed for now).

Revised task order (commit + review each):
- Task B: remove the 5-min timeout (server.requestTimeout = 0). Smallest, pinpointed, highest value.
- Task A: default command = batch; add explicit `tui` subcommand; `$0 [message..]` -> non-interactive run; empty -> help.
- Task C: `config verify` command + verify-before-launch.

---
## (Earlier broader design — kept for reference; partially superseded above)


## Goal (operator)
lmcode is for AGENT interaction, not humans. Make it a plain CLI:
1. Remove the TUI.
2. Everything currently set via the GUI/TUI must be settable via CLI (commands/flags/config).
3. Remove the timeout in batch mode (batch = the primary way agents run lmcode).

## Current state (verified, see durable-memory/build.md research)
- TUI is the DEFAULT command: `packages/opencode/src/cli/cmd/tui.ts:72` registers `$0`.
- Two interactive surfaces, both on `@opentui` (solid): full TUI `packages/tui`, and the
  `--mini` interactive run mode under `packages/opencode/src/cli/cmd/run/` (footer.*, scrollback.*, splash.ts, theme.ts, runtime.lifecycle.ts).
- `core` and `server` do NOT depend on tui/opentui. Dependency flows opencode -> tui -> core/server.
- Batch mode = `opencode run` (non-interactive). Loop ends on `session.status: idle`; NO wall-clock/idle timeout in the loop (run.ts:771-777).
- Config split: main `ConfigV1.Info` (opencode.json) vs `TuiConfig.Info` (tui.json) + TUI-only
  runtime state in `kv.json`/`model.json`/`session.json` under xdgState/lmcode.
- Writers exist: `Config.updateGlobal()` (jsonc-preserving) and `Config.update()` (project). No `tui.json` writer outside the TUI. No `config get/set` CLI; only read-only `debug config`.

## The "batch timeout" to remove
- Batch run loop itself has NO timeout. The only DEFAULT-ON timeout that can abort a model
  turn is `OPENAI_HEADER_TIMEOUT_DEFAULT = 10_000` at `packages/opencode/src/provider/provider.ts:35`,
  applied at `:208` (time-to-first-headers, OpenAI only).
- Provider `timeout` and `chunkTimeout` (`aisdk.ts:90`, `provider.ts:1720`) are opt-in (default off).
- DECISION (recommend): disable the default OpenAI header timeout for batch (or remove the default),
  and confirm no other default bound exists. Needs operator confirmation on exactly which timeout they hit.

## Proposed phased plan

### Phase 1 — Default command + remove batch timeout (small, low-risk, high-value)
- Repoint `$0` away from the TUI. Recommend `$0 [message..]` => non-interactive `run` so
  `lmcode "do X"` works directly; with no args, print help. (Alt: `$0` => help only.)
- Remove/disable the default OpenAI header timeout so batch runs are not cut off.
- This is shippable on its own and immediately satisfies goal #3 + "plain cli" default.

### Phase 2 — Remove the TUI code, deps, and build wiring
- Delete `packages/tui`, `cli/cmd/tui.ts`, `cli/tui/*`, the `--mini` interactive mode files,
  and the opentui/solid runtime deps in `packages/opencode/package.json`.
- Remove build.ts opentui pieces (solid plugin, cross-install of @opentui/@parcel/@ff-labs,
  parser-worker + tui-worker entrypoints/defines).
- Replace re-export shim files that proxy `@opencode-ai/tui` (`src/util/record.ts`, `util/locale.ts`,
  `util/error.ts`, `cli/logo.ts`, `cli/cmd/prompt-display.ts`, `parsers-config.ts`) with inlined local code.
- Decide fate of `tui.json` config + theme/keybinds: with no TUI they are dead. Drop from schema or leave inert.
- OPEN: also remove `packages/cli` (a second tui embedder) and the embedded web UI (`packages/app`)?
  Recommend: keep `serve`/`acp`/`web` server-side (agents need the server); treat web UI as out of scope.

### Phase 3 — CLI to cover remaining GUI settings (config get/set + targeted setters)
- Add `lmcode config get <key>` / `set <key> <value>` / `unset <key>` / `list`, backed by
  `Config.updateGlobal`/`Config.update` (`--global`/`--project`). Covers model, small_model,
  default_agent, autoupdate, share, compaction.*, disabled/enabled_providers, permission, etc.
- Targeted setters for gaps that are runtime/SDK-only today (recommend, in priority order):
  - `mcp enable/disable <name>` (flip `mcp.<n>.enabled`).
  - `provider enable/disable <id>` (edit disabled/enabled_providers).
  - `session compact/share/unshare/rename/fork <id>` (SDK already supports).
- Drop TUI-only cosmetics (themes, keybinds, animations, diff styles, sounds) — irrelevant without a UI.
- Make currently-interactive setup non-interactive: ensure `providers login`, `mcp add`, `agent create`
  all have complete non-interactive flag paths (most already do); auth API-key entry may stay interactive
  but accept a flag/stdin/env for agent use.

## Reviewer findings (resolved + verified by Lead)
- TIMEOUT (verified): `OPENAI_HEADER_TIMEOUT_DEFAULT = 10_000` at provider.ts:35, applied ONLY to
  the `openai` preset at :208 (time-to-first-headers). Run loop has NO wall-clock/idle timeout.
  Provider `timeout`/`chunkTimeout` are opt-in (default off). NOTE: this default applies only when
  the active provider is the `openai` preset; other presets (e.g. github-copilot) may not set it, so
  confirm the operator's actual symptom/provider. Recommended change: make the OpenAI header timeout
  opt-in (default disabled) so batch is never cut off; keep the machinery for opt-in via provider config.
  Update header-timeout.test.ts to the new default. (Reviewer2's "600_000" was incorrect.)
- DEFAULT COMMAND (Reviewer1, verified): do NOT reuse RunCommand.handler directly as `$0` — its
  interactive guard keys off `args._[0] === "mini"` (run.ts:279). A `$0 [message..]` catch-all also
  risks swallowing tokens; yargs prefers explicit subcommands but a message starting with a command
  name is ambiguous. Recommendation: dedicated thin `$0` adapter; empty invocation prints help.
  SAFEST: `$0 => help`, keep `lmcode run "..."` as the explicit batch entry. Also handle `temporary.ts`
  (second yargs entry registering only TuiThreadCommand) and `attach` (defaults to TUI unless --mini).
- BUILD/DEPS (Reviewer2 Part B was unreliable — cited non-existent cli/main.ts, core TuiGateway,
  @parcel/core, build.ts). GROUND TRUTH: build is `packages/opencode/script/build.ts` using
  `@opentui/solid/bun-plugin`; only "parcel" dep is `@parcel/watcher` (keep — file watcher, not a build
  tool). Removal order: sever imports (shims, mini mode) -> drop deps -> edit script/build.ts ->
  delete packages/tui -> bun install -> typecheck/test.
- CONFIG CLI (Reviewer3): `Config.updateGlobal` (config.ts:636) is a good base (jsonc-preserving,
  schema-validated). `Config.update` (project) is BROKEN for this use — writes `config.json` not the
  project `opencode.json(c)` and no jsonc preservation; must fix. `unset` needs `jsonc modify(...,undefined)`,
  not mergeDeep. Dotted keys collide with dotted provider/mcp ids -> need escaping or `--json`. `get/list`
  must read EFFECTIVE merged config and show winning layer; `set/unset` warn when shadowed by managed/remote/env.
  Arrays (disabled/enabled_providers) need add/remove ops, not scalar set.
  BLOCKER for "agent can fully configure lmcode": `providers login` has NO non-interactive API-key path
  (only Prompt.password, providers.ts:480) — MUST add `--api-key`/stdin/env. session compact/share/rename/fork
  have no CLI at all (session.ts only list/delete). `mcp add` flag-path is global-only (needs --project/--global).

## Open questions for reviewers + operator
1. Exact timeout: confirm it is the OpenAI header-timeout default (and/or request `timeout`). Any others?
2. Default `$0`: run-the-message vs print-help? (recommend run-the-message.)
3. Remove `--mini` interactive mode too (yes, it's a UI) — confirm.
4. Scope of web UI / `packages/app` / `packages/cli`: keep server, drop browser UI? Out of scope for now?
5. Config CLI surface: generic get/set/unset + a few targeted setters — is that the right line?
6. Big-bang vs phased delivery + commit per phase.

## Non-goals / keep
- `core`, `server`, `sdk` untouched (no TUI deps).
- `run`, `serve`, `acp`, `models`, `stats`, `export/import`, `session list/delete`, `db`, `mcp`, `auth/providers` stay.
