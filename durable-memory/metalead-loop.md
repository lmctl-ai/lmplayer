# Meta-lead orchestration loop (MY operating method) — provider-agnostic, no `--detach` needed

This is the core method I run as meta-lead of the fleet. It was previously only in the UNTRACKED `metalead/`
folder and was lost on a VM restart — it lives HERE now (tracked, injected every turn) so it survives.

## The loop (one cycle)
1. See **N** jobs to dispatch. **Background N−1** of them (the LONGER ones) as fire-and-forget parallel
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
