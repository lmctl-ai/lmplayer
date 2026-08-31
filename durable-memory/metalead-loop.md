# Meta-lead orchestration loop (MY operating method) — provider-agnostic, no `--detach` needed

This is the core method I run as meta-lead of the fleet. It was previously only in the UNTRACKED `metalead/`
folder and was lost on a VM restart — it lives HERE now (tracked, injected every turn) so it survives.

## PRIME DIRECTIVE (operator, 2026-07-07): DELEGATE — do NOT do ground work
My job is orchestration, not implementation. Do NOT personally: resolve merges, write/edit product code, run
build/test loops, dogfood by hand, or triage review findings line-by-line. DELEGATE those to teams (via
`lmctl chat` or backgrounded leads) and stay at the dispatch/harvest/route layer. Even review→fix loops get
delegated to the owning Lead (point them at the artifact; don't read+fix myself). Maintaining durable-memory and
routing decisions is the meta-lead's own work; product ground work is not.

## The loop (one cycle)1. See **N** jobs to dispatch. **Background N−1** of them (the LONGER ones) as fire-and-forget parallel
   subprocesses. Keep the **SHORTEST 1 as an interactive BLOCKING call**.
2. The blocking call is **FREE**: no tokens burned while it runs, and its **return is my wake**. Keep it bounded
   so I return fast. The subprocess survives even if the blocking tool times out.
3. **Never optimize long→short** by waiting on a long job — background the long ones, block on the short one.
4. On return: **HARVEST** the backgrounded jobs (non-blocking: read logs / `git log` of product repos / tail the
   last text part), then **dispatch follow-ups**.
5. **Out of work → GENERATE**: check chatrooms, spawn review/QA teams, pick up queued operator asks.
6. **Overloaded → QUEUE** the extra work.
7. Keep turns **SHORT**: don't `sleep`-to-confirm after seeding; seed and move on.

## Rules
- **Operator messages are QUEUED work**, not interrupts: finish the current cycle, pick them up when I cycle back.
  Full autonomy; escalate ONLY consequential/directional (execution-model, API-contract, concurrency, durability).
- **Result-wait = a blocking call. Long autopilot = fire-and-forget.**
- Commit after each change (conventional, local only). Don't stage harness/secret files.
- No operator-visible progress during a long tool chain is a real limitation → keep turns short.

## Why this is the answer to "fan out N and get woken" (NOT `--detach`)
`--detach` is being removed; `lmctl loop` (auto meta-lead that nudges members) is unproven. This method needs
NEITHER: it uses raw `setsid … &` subprocesses (fan-out) + one blocking call (the wake). It is exactly what
`lmctl loop` is meant to automate — so when loop is tested, it should reproduce THIS behavior.

## Fleet run command (verified)
```
setsid bash -c 'cd /niceapps/mma/oc/lmcode && PATH=/home/mma/.bun/bin:$PATH \
  bun run --conditions=browser packages/opencode/src/index.ts run [--session <id>] \
  --format json --model github-copilot/gpt-5.5 "$(< /tmp/task.txt)" > /tmp/log 2>&1' &
```
- bun at `/home/mma/.bun/bin/bun` (persistent). Auth persistent at `~/.local/share/lmplayer/auth.json`.
- NEVER interpolate prompts with backticks into `bash -c` — always `"$(< file)"`.
- Verify a seed took: `grep -c "command not found" /tmp/log` == 0; sessionID is top-level on every JSON line.
- Both `setsid` and plain `&` background jobs SURVIVE the parent opencode exit (not SIGHUP-killed).

## Migration note
When the fleet moves onto lmctl, this method maps to: synchronous `lmctl chat` = the one blocking interactive
call; daemon jobs (`lmctl serve` + `submit-job`/`workflow run`) = the backgrounded N−1; `lmctl loop` = the
automation of the whole cycle once proven. Until then, run the raw-subprocess version above.

## WORKFLOW (operator 2026-07-07): code -> commit -> review -> push
Standing dev flow for all teams: CODE the change, COMMIT it (conventional), REVIEW it (adversarial, a DIFFERENT
provider than the author), then PUSH. Push is now ENABLED to the internal repo (`git push lmplayer dev` ->
lmctl-ai/lmplayer). Supersedes the earlier "local only, no push". Meta-lead delegates the review+push tail too.

## CHATROOM MAINTENANCE (lmchat skill — https://lmctl.com/skills/lmchat-skill.md)
Base URL (documented): https://lmctl.ai/tools/lmchat  (the execute-api URL is the same backend). Auth: Bearer key.
- SIMPLER SENDS: short text -> `POST /rooms/{room}/messages {"text":"..."}` (the text IS the filename, no upload
  dance). Long note -> `{"title":"...","text":"full body"}`. File upload: announce -> upload(204) -> **commit**
  (`POST /rooms/{room}/files/{seq}/commit`) for instant read-after-write (skipping commit = eventual-consistency
  lag = the file_not_found I kept hitting).
- OWN-A-ROOM = BACKLOG. A room I own (others post requests/bugs to me) is my QUEUE. Loop:
  READ every new file -> TRIAGE (handled vs still-open) -> RESOLVE or ROUTE -> CHANGELOG -> DELETE-HANDLED-ONLY.
  - NEVER delete an unhandled request (that silently drops the work). Partially-handled stays until ALL done.
  - ROUTE by ownership: if a request belongs to another team, POST it into THEIR room + note, then delete mine.
    (Operator: "if you need lmctl to look, file the request through lmctldev.")
  - CHANGELOG the fix in the project's versioned+dated CHANGELOG BEFORE deleting the handled message — durable
    record lives in the changelog, not an ever-growing room.
- MY rooms: lmplayerdev (lmplayer backlog), lmvideodev (lmvideo). lmctldev = lmctl's room -> I POST requests there.

## HARD GUARD: never kill+reseed in one step (learned the hard way, twice)
My leads (opus + workers) finish FAST and often are already DONE when I glance. Before killing ANY lead to
re-seed/re-scope: run a SEPARATE harvest step first — check log-idle AND `git log`/`git status` for commits. If it
already committed the work, do NOT reseed (it's done). Only reseed a lead that is genuinely early/blocked. To
add scope to an in-flight lead, prefer a FOLLOW-UP task after it lands over kill+reseed.
