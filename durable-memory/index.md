# lmcode — Portal Memory (Index)

Shared, provider-agnostic, multi-file memory for the lmcode project (an OSS opencode
fork being reshaped into a plain CLI for LLM/agent use). Read this first on every fresh
session. This directory is the "portal": it is committed to the repo so the memory is
externally persisted and survives any single agent's session.

## What lmcode is
A Bun + TypeScript monorepo (Turborepo) for an AI coding agent: server, CLI, TUI, SDK,
web/desktop frontends. Runtime built heavily on Effect v4 / effect-smol. Default branch: `dev`.
Direction: lmcode is for AGENTS, not humans — a plain CLI where everything GUI/TUI does is
reachable via commands + editable config (with a verify step). The TUI is kept but no longer
the default.

## Docs in this portal (each a focused, LLM-friendly file)
- `notification-output-limit.md` — NOTIFICATION-OUTPUT-LIMIT: mandatory Codex OAuth cap omission for unattended turns without re-enabling plugin hooks.
- `filesystem-default-access.md` — FS-DEFAULT-ACCESS: default cross-directory access in both runtimes, explicit restriction precedence, and structured Linux workdir handling.
- `provider-openai-astra.md` — verified `openai/gpt-6-astra` via Codex OAuth, exact-name filter fix, older-binary declaration workaround, published example, and clean diagram lint.
- `direction.md` — operator north star: CLI + single-user sequential REST microservice, file-based permissions (no popup), standalone config (no parent/sibling merge).
- `runbook.md` — how to run/auth/test lmcode in dev (toolchain, copilot OAuth device flow, default model, wrapper).
- `cli-commands.md` — the agent-facing CLI surface added in this work (models, auth list, run --effort, config, default command).
- `models-and-effort.md` — model selection, variants/effort tiers (xhigh = "extra high"), entitled list + which models actually work.
- `config-cli.md` — config schema, writers (updateGlobal/patchJsonc), precedence/shadowing, effort-default decision, non-interactive gaps.
- `build.md` — the single source of truth for XDG app dirs (global.ts:10) + rename notes.
- `design-cli-only.md` — design + reviewer findings for the agent-CLI direction (default command, the "5-minute timeout" investigation, config).
- `design-permissions.md` — THE permission model: 2 modes — default CODING (native tools == shell tier, broad) vs SECURED/precise control (no general shell, allowlisted native tools + specific options, or wrappers; lmprobe = exemplar; IAM-style default-deny). Read before touching tool permissions.
- `metalead-loop.md` — MY core operating method: background N−1 + 1 interactive blocking call = fan-out + wake (no `--detach`). Fleet run command. Read this to run the fleet.
- `lmctl-manual.md` — lmctl operational cheat-sheet for migrating the fleet onto lmctl (chat/jobs/loop, `--detach` removed).
- `lead-brief-lmctl.md` — how the Lead sends via lmctl (chat/seed/auto-resume), fleet.lmctl, and the operator's web console (lmctl.ai, not for me). Docs at lmctl.com.
- `contract-session-metrics.md` — STABLE `session-metrics/v1` JSON contract for `lmplayer session metrics <id> --json` (ORG-METRICS). What lmctl `health`/queries consume; persisted-vs-derived rules, cost formula.
- `integration-lmctl-tokens.md` — lmctl token health contract: read `session` table token columns (or `GET /session/:id .tokens`). Superseded/extended by `contract-session-metrics.md`.
- `remote-poll-channel.md` — CLIENT-ONLY/OUTBOUND-ONLY remote-operator poll channel prototype: `RemoteChannel` (poll/respond) + `RemotePoller`, `run --remote-poll` flags, how it reuses the exact `client.session.prompt` admission path, and the fake-LLM round-trip test. Includes the "copilot Claude must be declared for lmctl" gotcha.
- `provider-ollama.md` — config-free `ollama/<model>` (extended-name `@host`/`OLLAMA_HOST` scheme, seeded built-in provider, on-demand tag synthesis), conditional chat-only for `toolcall:false` models, and the `LMPLAYER_LLM_VERBOSE` file-logging switch. Includes the BUILT-BUT-UNTESTED live-ollama handoff. Commits `108b8bfdf` + `788cc54fc`.
- `review-2026-08-20-codebase-and-direction.md` — external deep review of dev post job/cron port: pillar re-verification (1+2 hold; 3 broken by ungated notification/cron turns), missing `eaa7ccbf6` claim-liveness port (CHANGELOG wrongly claims it), serve-SIGTERM job-shutdown gap, prioritized next directions.
- `finding-tui-resize.md` — TUI is NON-DEFAULT not disabled (launch `lmplayer tui`/`attach`, PTY-verified). SHIPPED FIX (commit `f1d158f51`): `@opentui@0.4.3` `processResize` (alt-screen) never forces a full repaint (private `forceFullRepaintRequested`/`this.ln`), so a real-terminal resize leaves content cut off; lmplayer's own resize handler (`app.tsx` + `util/renderer.ts forceFullRepaint`) clears `currentRenderBuffer` to a sentinel baseline so every cell repaints regardless of theme. Also: sidebar hidden by default (`routes/session/index.tsx:249` "auto"→"hide"; toggle `<leader> b`). Read for the @opentui render-loop internals + how to test the TUI headlessly.

## How to use / extend this memory
- Start here; open the focused doc for your area.
- After finishing a task, record durable facts (commands, file:line, invariants, gotchas) in the
  relevant doc and update this index. Avoid transient chat state.
- Keep it terse and accurate; verify claims against code before writing.

## Team workflow rules (operator-set)
- ALWAYS commit after a completed, reviewed change. Conventional messages: `type(scope): summary`.
- Process: Lead breaks work into tasks -> Coder implements -> a Reviewer reviews -> fix loop -> Lead commits.
  For complicated design, ask all reviewers; Lead is the technical arbiter and final sanity reviewer.
- Do NOT stage team/harness files: `lmcode.lmctl`, `.mcp.json`, `.opencode/opencode.json`, `.opencode/opencode.jsonc`.

## Build toolchain note (gotcha)
This workspace ships with no `node_modules` and no `bun` on PATH by default. Bootstrap: run `which bun` or
check `$PATH`/`$HOME/.bun/bin` first — the exact install path has been observed to vary by host/VM (seen at
both `/tmp/opencode/.bun/bin/bun` and `~/.bun/bin/bun`); don't hardcode one. Once found, `bun install` at
repo root. Typecheck per package: `bun run typecheck`
(`tsgo --noEmit`). Tests run per package dir (never from repo root — guard `do-not-run-tests-from-root`).
A dev `lmcode` command is installed at `~/.local/bin/lmcode` (runs from source).

## Authoritative source files to cross-check
- `AGENTS.md` (house rules/style), `CONTEXT.md` (V2 session runtime language), `CONTRIBUTING.md`, `package.json`, `turbo.json`.

## Task log (delivered, committed)
- `fix(core)`: XDG app dir `opencode` -> `lmcode` (global.ts:10) so lmcode doesn't collide with a real opencode install.
- `fix(copilot)`: device-flow auth keeps polling on HTTP 400 authorization_pending (was aborting login instantly).
- `feat(cli)`: `models --json` with per-model effort variants.
- `feat(cli)`: `config verify` + readable config errors at verify and launch (shared FormatConfigError).
- `feat(cli)`: `config get/set/unset` (jsonc-safe, schema-validated, global).
- `feat(cli)`: `run --effort` alias + shows `> agent · model · effort` in output.
- `feat(cli)`: `auth list` shows entitled models per authed provider (+ `--json`).
- `chore`: rename CLI binary/command `opencode` -> `lmcode` (bin, build, scriptName, Dockerfile).
- `feat(cli)`: default command sends a prompt; TUI moved to explicit `lmcode tui`; piped stdin runs; bare lmcode -> help.
- `feat(cli)`: `models --test` probes each entitled model (tool-less single turn), reports OK/FAIL, exit non-zero on any fail.
- `feat(opencode)`: `session metrics <id> [--json]` — stable `session-metrics/v1` (tokens+cost_usd+latency+tools+files) read offline from the persisted SQLite store; tokens from the `session` row (fixes lmctl `Tokens: n/a`), cost DERIVED from tokens×model pricing (persisted `session.cost` is 0). Pure `createSessionMetrics` in `packages/opencode/src/cli/cmd/session.ts`; test `test/cli/session-metrics.test.ts`. Contract: `durable-memory/contract-session-metrics.md`.
- `feat(opencode)`: remote-operator poll channel PROTOTYPE (branch `remote-poll-channel`, commit `4ea42dbab`, pushed to lmplayer; Coder=sonnet-5, Reviewer1=gpt-5.5 APPROVE). Client-only/outbound-only in-process poll loop: `RemoteChannel` (poll/respond; HTTP-mailbox + stub) + `RemotePoller` in `packages/opencode/src/remote/`, `run --remote-poll [--poll-token --poll-interval --response-detail]` (hidden, zero change when absent), injects via the exact `client.session.prompt` path, fake-LLM round-trip test `test/remote/poller.test.ts` (5 pass). See `durable-memory/remote-poll-channel.md`.
- `test`: TUI launch-registration + interactive resize regression coverage (commit `ae534e94c`, pushed to lmplayer dev; Coder=sonnet-5, Reviewer1=gpt-5.5 APPROVE-WITH-NITS). Confirms `lmplayer tui`/`attach` reachable (non-default by design) and that the interactive TUI + session message content fully re-render/re-wrap on resize (no cut-off). No functional source change — the reported "TUI disabled" / "resize cut-off" were already-correct/non-reproducible; findings in `durable-memory/finding-tui-resize.md`.
- `feat(opencode)`: config-free Ollama + conditional chat-only + verbose LLM logging (commits `108b8bfdf` Slice 1+3, `788cc54fc` Slice 2, pushed to lmplayer dev; Coder=sonnet-5, Reviewer1=gpt-5.5 adversarial, APPROVE after a 2-blocker fix loop). `--model ollama/<model>` resolves with NO config/key (built-in OpenAI-compatible provider at localhost:11434/v1; `@host` suffix + `OLLAMA_HOST` override; arbitrary tags synthesized on demand); models flagged `toolcall:false` (incl. all ollama) are sent NO tools → plain text (chat-only), capable copilot models unchanged; `LMPLAYER_LLM_VERBOSE=1` writes raw request/stream/tool-parse JSONL to `Global.Path.log/llm-verbose.log`. Additive/isolated: 4 copilot models re-smoked OK. LIVE ollama path is BUILT-BUT-UNTESTED (no ollama on host). Full details + handoff in `durable-memory/provider-ollama.md`.
- `fix(tui)`: force full repaint on resize + hide sidebar by default (commit `f1d158f51`, pushed to lmplayer dev; Coder=sonnet-5, Reviewer1=gpt-5.5 adversarial APPROVE-WITH-NITS). Operator re-raised the cut-off as a REAL physical-terminal bug: `@opentui@0.4.3` `CliRenderer.processResize` (alt-screen, the default for `lmplayer tui`) only diff-renders and never forces a full repaint (unlike resume/capability/split-footer paths), so a resize can leave content truncated with no repaint. Fix: `packages/tui/src/util/renderer.ts` `forceFullRepaint` clears `currentRenderBuffer` to an off-screen sentinel `REPAINT_INVALIDATION_COLOR` (theme-independent — Reviewer1 caught that the default opaque-black clear would skip blank cells under a black theme), wired via `renderer.on("resize", …)` in `app.tsx`. Plus Task C: sidebar hidden by default (`routes/session/index.tsx:249` "auto"→"hide"; toggle `<leader> b`/Ctrl+X b; model/cost stay in the prompt footer + status line). Tests: `packages/tui/test/repaint.test.tsx` (unit) + a wiring test in `test/resize.test.tsx`. Task A needed no change (already launchable; PTY-verified). See `durable-memory/finding-tui-resize.md`.
- `feat(opencode)`: PROFILES — positive tool provisioning + lean system prompt (branch `lean-profiles`, commit `6a2f51d2d`, pushed to lmplayer; Coder=sonnet-5, Reviewer1=gpt-5.5 adversarial → APPROVE-WITH-NITS after a 2-blocker fix loop). Inverts materialize-all-then-deny: an agent may declare `provision: string[]` (positive tool allowlist) so ONLY those tools' model-facing definitions are built/sent regardless of the permission ruleset (`registry.tools()` bypasses `Permission.disabled`; `resolveTools()` is the final gate; infra `invalid`/`_noop` sentinels exempt, never offered). Ship a built-in `lean` agent (`--agent lean`) for weak models (qwen2.5): `prompt`=`session/prompt/lean.txt` (monitor+delegate via lmctl, ~91% smaller than default.txt) + `provision:["bash"]`. Additive — default `build` unchanged. Proof: registry+llm tests assert `body.tools == ["bash"]` under allow-all permission. Legacy path only; V2 `core` `materialize()` is the follow-up seam. Full details in `durable-memory/model-profiles.md`.

- `chore`: upstream refresh, 586 commits from `anomalyco/dev` (merge `bbb19361b`, pushed to lmplayer dev; snapshot regeneration `af0b30248`). Three conflicts in lmplayer's own compaction feature resolved by keeping lmplayer's behavior (upstream's `truncate`/`serialize` prompt rewrite was not adopted); glob/help-text snapshots regenerated separately. See CHANGELOG.md `[Unreleased]`.
- `feat(session)`: ported the session-scoped background-job + cron-scheduler subsystem and a run of concurrency/reliability fixes from a sibling opencode fork (cherry-picked and merged straight to `dev`, no branch — `8b2b7c250`/`9d098f4e8`). Adds persisted background shell jobs (`SessionJobStore`/`SessionJobRuntime`, restart-durable, cross-turn notification delivery), an in-memory cron scheduler (`tool/cron.ts`), SQLite WAL/lock-contention resilience (`sqlite-retry.ts`, periodic WAL checkpoint), ACP event-subscription resubscribe-with-cap, message-ID recency comparison (fixes a ~2.2-year ID-wraparound bug), and bounded compaction-boundary pagination. lmplayer's own pre-existing `BackgroundJob` (in-memory task tracking, `packages/core/src/background-job.ts`) is untouched — different feature, no collision. New integration test (`test/session/prompt.test.ts`, "launches a background job from a real LLM bash tool call...") exercises the full mock-LLM path end to end; full suite green (`packages/core` 1109/1109, `packages/opencode` 3623/3623 modulo pre-existing order-dependent TUI-plugin/attention flake, confirmed 0-fail in isolation).
- `fix(session)`: closed 3 real gaps an external review (Fable, `review-2026-08-20-codebase-and-direction.md`) found in the above port — (1) notification/cron-fired turns now go through the same process-global sequential gate as HTTP turns (`gateSerialize` wrap in `prompt.ts`'s two wake callers; direction pillar 3 was silently broken by the port), (2) cherry-picked the missing `eaa7ccbf6` notification-claim-liveness fix that the original 19-commit port dropped despite the CHANGELOG claiming it landed, (3) `serve`'s SIGTERM path now runs `SessionJobRuntime.shutdown()` before exit, matching the one-shot CLI path (previously orphaned detached job processes). Also: `cron create` now asks permission (was ungated, unlike `job stop`), new `test/server/execution-gate.test.ts` unit-covers the gate mechanism itself. Full findings + prioritized next-direction list in the review doc.

## Open / TODO (not done)
- The operator-reported "hard 5-minute timeout" is NOT in lmcode's default batch path (in-process run is
  unbounded; only a stale SDK doc mentions 300000). Needs the operator's exact invocation/symptom to fix the
  right thing. See design-cli-only.md.
- claude-* via github-copilot: RESOLVED in the current build — `claude-sonnet-5` and `claude-opus-4.8`
  both return OK via github-copilot (re-smoked 2026-07-08 from source, `run --format json` exit 0), alongside
  gpt-5.5 and gemini-2.5-pro. The old 404 (anthropic /v1/messages shim) note is stale. See models-and-effort.md.
- Portal "external location": currently = committed to this repo. If a separate external location is wanted, TBD.
- Branding leftovers from the rename: ASCII logo + "opencode" describe strings, platform package names
  (opencode-<plat>), publish.ts, postinstall.mjs. Cosmetic/packaging follow-up.
- Non-interactive API-key login path missing for `providers login` (copilot OAuth works). See config-cli.md.
