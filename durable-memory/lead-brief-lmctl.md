# Lead brief — how to send via lmctl + the web console (operator mailbox)

For the fleet Lead operating under lmctl. Session lifecycle is LMCTL'S job: seed fresh, and lmctl auto-resumes on
every subsequent chat (verified — `--session` returns the same id and retains context; you never hand-manage it).

## Where things live
- **Docs / manual: https://lmctl.com** (install, CLI reference, concepts, teamfiles, workflows). Read here first.
- **My interface = the `lmctl` CLI** (chat/ls/tail/health/seed). https://lmctl.ai is the human operator's browser
  console — NOT much use to me as a CLI agent; I don't drive it. It's just how the operator reaches the Lead.

## PROVIDER + MODEL RULE (operator, standing)
- ALLOWED providers: **`opencode`, `lmplayer`, `copilot`** (all covered by the copilot subscription). Use
  `github-copilot/*` models (or `opencode/*` models). Prefer `provider=lmplayer` to dogfood our own.
- NOT ALLOWED: `claude`, `codex`, `gemini`, `qwen`, `agy` (separately billed / paid accounts = costs money).
- The constraint is on the PROVIDER, not the model family — `github-copilot/claude-sonnet-4.6` is copilot-billed
  and fine. Current fleet complies: fleet.lmctl + all leads use `provider=lmplayer` + `github-copilot/*`.

## MODEL ROUTING (use the STRONG models; don't default to sonnet)
All verified working via `provider=lmplayer` (2026-07-07): `github-copilot/claude-opus-4.8`,
`github-copilot/gpt-5.5`, `github-copilot/gemini-2.5-pro`, `github-copilot/claude-sonnet-4.6`.
- **Hard design / leads / tricky logic → `claude-opus-4.8`** (strongest). Don't default to sonnet for these.
- **Routine coding workers → `claude-sonnet-4.6`** (cheaper, capable).
- **Adversarial review → a DIFFERENT PROVIDER than the author** (lmctl's core value: uncorrelated blind spots).
  Anthropic author (sonnet/opus) → review with `gemini-2.5-pro` (Google) or `gpt-5.5` (OpenAI), and vice-versa.
- gpt-5.5 had a transient "Unexpected server error" window earlier; it recovered. If a model errors, switch, don't stall.
- Gotcha: `lmplayer models --json` catalog is STALE — it omits opus-4.8/gpt-5.5/gemini-2.5-pro even though they
  run fine. Don't trust the catalog for availability; smoke-test.

## Team file
- `/niceapps/mma/oc/fleet.lmctl` — the migrated fleet (first `_MEMBER_` = Lead; members = product workstreams,
  real sessionids kept + aliased). Lint it with `lmctl lint /niceapps/mma/oc/fleet.lmctl` (passes; only the known
  model-verify warning until `lmplayer models` lands).

## STRONG TEAM (operator-set 2026-07-07, in fleet.lmctl) — all provider=lmplayer, github-copilot
- **Lead → claude-opus-4.8** (design + orchestration)
- **Coder → claude-sonnet-5** (implementation)
- **Reviewer → gpt-5.5** (adversarial review — different provider from the Anthropic Coder)
- **QA → gemini-2.5-pro** (search + video/image QA; multimodal)
Re-seed after any restart (sessionids are ephemeral): `lmctl seed /niceapps/mma/oc/fleet.lmctl`. Drive with
`lmctl chat /niceapps/mma/oc/fleet.lmctl <Alias> "..."` (auto-resume). Inspect with `lmctl tail`/`health` (set
`OPENCODE_DB=~/.local/share/lmplayer/opencode-dev.db` since the installed binary is dev-channel).

## Lead -> member (the everyday send)
- `lmctl chat /niceapps/mma/oc/fleet.lmctl <Alias> "<prompt>"` — sends to a member; lmctl auto-resumes that
  member's session (stateful). Also accepts `<teamfile>:<alias>` form and `--permission-mode plan|yolo`,
  `--idle-timeout <dur>`, `--from <tf>:<alias>`, `--root <tf>`.
- Add a NEW member: edit fleet.lmctl (`_MEMBER_ alias=X provider=lmplayer model=github-copilot/claude-sonnet-4.6`)
  then `lmctl seed /niceapps/mma/oc/fleet.lmctl` — seeds only the missing session; existing ones are kept.
- Cross-team calls are automatic at runtime (no wiring), with cycle protection.
- MCP path (already available to me): the `lmctl_lmctl_chat` tool (synchronous chat to a member by teamfile+alias)
  and `lmctl mcp` (stdio bridge). Use the tool for one blocking send; use it sparingly.
- Inspect members read-only: `lmctl ls`, `lmctl tail <tf> <alias> [--watch]`, `lmctl health <tf> <alias>`.
  (Dev-channel gotcha: if a member's session is invisible, it's in `opencode-dev.db` — set
  `OPENCODE_DB=~/.local/share/lmplayer/opencode-dev.db`. Release builds use `opencode-local.db`.)

## Operator <-> Lead (the operator's side — I don't drive this)
The operator drives the Lead from the lmctl.ai web console (a human UI). I don't use it; I only need to know it
exists so I understand where operator prompts come from. Mechanics (operator/setup side):
- Local device id initialized: `731abf91-a209-4faa-8ba0-680c0fbd8203` (`~/.lmctl/device.json`).
- Console connection: `lmctl serve > lmctl.log 2>&1 &`, then `lmctl device login --user-id <cognito-sub>
  --access-key <refreshToken>` (creds from the lmctl.ai account — OPERATOR provides). The daemon then exchanges
  with the console over the cloud S3 mailbox (GET-next-sequence) — the "operator in the website, Lead as virtual
  server" model. `lmctl device prompt --root <tf> --text "..."` is the CLI equivalent of a console send.
- Direct `lmctl chat` needs NO daemon; only the operator's cloud-console path needs `serve` + `device login`.

## Status right now
- Device id: initialized. Daemon: NOT running (`lmctl api status` → network failure) — start `lmctl serve` +
  `device login` when wiring the console. `lmctl status` outside a project: "no project at this path".

## TEAM COMPOSITION / COST TIERS (operator 2026-07-07)
Mix tiers in a big team to match cost to difficulty:
- POWERFUL AGENTIC tier (paid, github-copilot): opus-4.8 (design/lead), sonnet-5 (coding), gpt-5.5/gemini
  (review/QA). Use for COMPLEX multi-turn agentic tool work.
- FREE SIMPLE tier (local ollama, e.g. `ollama/qwen2.5`, virtually FREE — no API cost): CHAT-ONLY members
  (tools suppressed for these simple models — conditional, see design-permissions/ollama slice). Use for SIMPLE,
  high-volume, deterministic-ish tasks: translation, classification, and returning a text signal a CONTROL
  SYSTEM interprets (done / has-issue / needs-escalation). They are members of the same big team.
Strategy: route simple/high-volume work to FREE ollama; reserve the paid models for real agentic reasoning.
(Enabler in progress: config-free `ollama/<model>` extended name + conditional chat-only mode — ollama lead.)
