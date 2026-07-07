# lmctl operational manual — readiness cheat sheet (for migrating the fleet onto lmctl)

Source: lmctl.com docs (read 2026-07-07). Goal: once lmctl ships `provider=lmplayer`, drive the meta-lead fleet
via lmctl instead of raw `lmplayer run` subprocesses.

## Install / env
- `npm install -g @lmctl-ai/lmctl` — Linux/WSL2, Node 24.15+. State under `~/.lmctl/` (SQLite). Env prefix `LMCTL_`.
- lmctl does NOT store provider keys; each provider CLI authenticates itself. lmctl just drives them.
- `--db PATH`, `--workspace NAME`, `lmctl workspace init|use|migrate`. Daemon: `LMCTL_API_URL` (default
  http://127.0.0.1:8787), `LMCTL_API_TOKEN`, `lmctl serve --port 8787`.

## Core objects
project (dir bound to a default workflow+team) · team (named members) · member (alias backed by a provider CLI) ·
workflow (routed sequencing def) · job (queued request) · run (live execution) · attention (durable operator
notification) · durable-memory (provider-agnostic project knowledge; sessions are disposable cache).

## Teamfile (.lmctl) — matches my hierarchical model
- `_MEMBER_` lines; FIRST member = Lead; rest are its members. Intra-team wiring is implicit.
- `lmctl ls` already prints `_MEMBER_` lines — paste into a `.lmctl` and fill `alias=`.
- `lmctl lint <tf>` (syntax/session/model checks) · `lmctl seed <tf>` (starts each provider once, captures session
  id) · `lmctl clone <src> <dst>` (copy WITHOUT session ids) · `lmctl plan <dir> --provider codex` (starter team).
- Cross-team calls: automatic at runtime, no wiring. Cycle protection: stops if target is an active ancestor AND
  (recurs within ~60s OR revisited >2×). Fan-out/diamond allowed. `_CONNECT_`/`lmctl connect` removed (no-op now).

## Daemon (executes queued work)
- `lmctl serve > lmctl.log 2>&1 &` — always-on local daemon that EXECUTES jobs/runs. Start once, leave running.
- lmctl.ai web console (optional subscription) connects to THIS local daemon over an **S3 mailbox** (GET-next-seq
  poll), metered. >>> This is exactly the operator's "lmctl operator mailbox / operator-in-website" model. <<<

## Driving members (the loop maps directly to my meta-lead pattern)
- `lmctl chat <tf> <alias> "..."` — message a member; Lead relays context. Reviewer being a different
  provider/model = adversarial review.
- `lmctl chat <tf> <alias> "..." --detach` — BACKGROUND delegation (fire-and-forget). Then `lmctl jobs` /
  `lmctl jobs watch <id>`. == my "background N-1" step.
- `lmctl nudge <tf>[:alias]` — WAKE: delivers an idle Lead's completed-but-undelivered `--detach` results by
  re-invoking it (a Lead only processes detached results on its NEXT turn). Read-only no-op if nothing pending;
  skips a busy target (never interrupts). == my "harvest bg jobs" step + the pull-based wake.
- `lmctl loop <tf>:<alias>` — autopilot: repeats a prompt until the member ends with `ALL DONE` or
  `OPERATOR ESCALATION` (`--max-iterations` default 50, `--prompt`). == the operator's "job 255 round engine".
  (Ships with provider slice A; not yet in public docs.)
- Inspect: `lmctl ls` / `--runs` · `lmctl tail <session>|--run <id> [--watch]` · `lmctl health <session|tf|--run>` ·
  `lmctl terminal <tf>:<alias>|--run <id>|--size`.

## Jobs / workflows / escalations / issues
- `lmctl api submit-job --workflow W --project P --inputs '{...}'` (blocks to terminal) or `lmctl workflow run ...`.
- `lmctl api jobs|runs|run <id>|attentions|attention ack <id>|daemon state|daemon cycle` (many support `--json`).
- Paused workflows surface as attentions: `lmctl api escalations list --json` / `respond <attn_id> "answer"`.
- Issues: `lmctl api issues create P --title .. --body .. [--severity --labels --ai-test-path]` / `list P --status
  open --json` / `show <id>` / `close <id> --commit-hash <sha>` / `reopen` / `claim <id> --assigned-run-id <run>`.
- Files: `lmctl api upload <file> --project P --json`. Device/MCP: `lmctl device init|id|prompt`, `lmctl mcp`.

## lmplayer-as-provider (once shipped, per my review = Version A)
- `provider=lmplayer`, `--model github-copilot/<id>` (config-free), `--effort` (alias of --variant), YOLO =
  `--dangerously-skip-permissions`. Session store = opencode-compatible SQLite at
  `~/.local/share/lmplayer/opencode-local.db` (channel-suffixed; `OPENCODE_DB` override) — lmctl reads it via the
  opencode session-reader, so `lmctl ls/tail/health` all work.
- I ALSO have an MCP tool `lmctl_lmctl_chat` (synchronous chat to team member by teamfile+alias). Prefer
  `chat --detach` + `jobs`/`nudge` for background.

## Migration plan (raw subprocess -> lmctl)
1. `lmctl serve &` (daemon). 2. Author fleet teamfile(s) with `provider=lmplayer` members. 3. `lmctl lint` + `seed`.
4. Replace `setsid lmplayer run ... &` with `lmctl chat <tf> <alias> "..." --detach`. 5. Replace log-tailing
   harvest with `lmctl nudge` + `lmctl jobs`. 6. Sub-teams via cross-team calls (automatic). Meta-lead = a Lead.
