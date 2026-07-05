# lmcode dogfood findings (from building svg-transit + lmvideo)

Real lmcode issues surfaced by the battle-test dogfood (two teams building greenfield projects WITH lmcode).
Consolidated + prioritized. Source: svg-transit & lmvideo `DOGFOOD-lmcode-findings.md`.

## P1 — fix now (blocked/frictioned both teams)
1. **Structured `git` tool workdir rejects EXTERNAL repos.** (both teams) The scope-confined `workdir`
   (resolveWorkdir, confines to session workspace root) rejects a legitimately-designated target repo
   outside the lmcode checkout (`/niceapps/mma/oc/svg-transit`, `/niceapps/mma/oc/lmvideo`) with "resolves
   outside the workspace root" — forcing a fall back to raw shell for multi-repo work. Fix: allow declared/
   approved external roots (e.g. session-level additional accessible roots, or honor user-designated target
   repos), so structured tools work across repos without disabling the escape guard.
2. **`git switch -c <branch>` false-positive in the deny-list.** The `-c` command-execution guard
   (meant for global `git -c key=val ...`) also blocks the safe `git switch -c <branch>` (branch creation),
   teaching agents to fall back to `git checkout -b`. Fix: distinguish global pre-subcommand `-c` from
   `switch -c`; allow `switch -c <branch>`.

## P2
3. **`git branch --show-current` classified as `verb: modify`.** Read-only inspection misclassified;
   noisy audit + could trigger caution/prompts. Fix: classify branch inspection as read.
4. **glob/search does not honor `.gitignore` by default.** `glob("**/*")` in a JS/TS repo returns
   `node_modules/**` noise. Fix: default to honoring `.gitignore` for codebase exploration, explicit opt-in
   to include ignored.

## P3
5. **No structured session tail/ls tool for a lead; JSONL logs hard to inspect.** Leads read `/tmp/*.log`
   directly because each JSONL event is a huge metadata-rich line. We have CLI `session ls`/`tail` — expose a
   structured tool + a compact event view (text/tool/status/errors only, filter by session/type, paginate).
6. **Shell quoting fragility for dense one-liners** (regex/quotes in `bun -e`), easy to mangle. A structured
   JS/TS eval/scratch helper would avoid the shell parser for short diagnostics. (Overlaps the replace-bash
   thesis; low priority since bash stays on for coding.)

## Status
- P1 (git workdir external + switch -c) + P2 (branch classify + glob gitignore): seeding an lmcode fix cycle.
- P3: queued.

## New findings (cycle 2: svg-transit M2 + lmvideo svg/diagram slice)
7. **Subprocess spawn of `bun`/`node` fails (ENOENT) from project code under a tool.** (lmvideo, High as felt)
   Root cause: bun is installed at the NON-STANDARD `/home/mma/.bun/bin` which is not on the default PATH, so
   a project's `Bun.spawn(["bun"...])`/`node` fails unless PATH is explicitly set (node itself IS installed at
   /usr/local/bin/node). Repro: `Bun.spawnSync(["bun","--version"])` works only with PATH including the bun dir.
   Impact: any built project that shells out to a CLI breaks under the fleet. Mitigations: (a) prefer library
   imports over CLI shell-out; (b) lmcode/tool subprocess env could ensure PATH includes the running bun's dir
   (process.execPath dirname); (c) env fix: put bun on a standard PATH. Low-priority lmcode change; env-level.
8. **claude-sonnet-4.6 (copilot) hit a 32K output-token step limit → worker failed with 0 commits.** (svg-transit M2)
   A worker on claude-sonnet-4.6 aborted a large step at the 32K output cap; retry on gpt-5.3-codex succeeded.
   Finding: lmcode should handle/soft-land the provider output-token cap (chunk long outputs / recover) rather
   than fail the step. Also informs model-balancing (claude good but watch big single-step outputs).
