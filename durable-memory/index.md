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
- `runbook.md` — how to run/auth/test lmcode in dev (toolchain, copilot OAuth device flow, default model, wrapper).
- `cli-commands.md` — the agent-facing CLI surface added in this work (models, auth list, run --effort, config, default command).
- `models-and-effort.md` — model selection, variants/effort tiers (xhigh = "extra high"), entitled list + which models actually work.
- `config-cli.md` — config schema, writers (updateGlobal/patchJsonc), precedence/shadowing, effort-default decision, non-interactive gaps.
- `build.md` — the single source of truth for XDG app dirs (global.ts:10) + rename notes.
- `design-cli-only.md` — design + reviewer findings for the agent-CLI direction (default command, the "5-minute timeout" investigation, config).

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
This workspace ships with no `node_modules` and no `bun` on PATH by default. Bootstrap: bun is at
`/tmp/opencode/.bun/bin/bun`; run `bun install` at repo root. Typecheck per package: `bun run typecheck`
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

## Open / TODO (not done)
- The operator-reported "hard 5-minute timeout" is NOT in lmcode's default batch path (in-process run is
  unbounded; only a stale SDK doc mentions 300000). Needs the operator's exact invocation/symptom to fix the
  right thing. See design-cli-only.md.
- claude-* via github-copilot return 404 in this build (route via /v1/messages anthropic shim); gpt/gemini work.
  Likely a wrong endpoint/base or integrator entitlement — needs investigation. See models-and-effort.md.
- Portal "external location": currently = committed to this repo. If a separate external location is wanted, TBD.
- Branding leftovers from the rename: ASCII logo + "opencode" describe strings, platform package names
  (opencode-<plat>), publish.ts, postinstall.mjs. Cosmetic/packaging follow-up.
- Non-interactive API-key login path missing for `providers login` (copilot OAuth works). See config-cli.md.
