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
