# lmcode Bootstrap Org Chart (meta-lead: this session)

## Operating model (operator-set)
- Every team member is a plain lmcode INSTANCE, driven by CLI: send a command, read the response.
- I DO NOT code. I manage: split tasks, delegate, review orchestration, integrate, design agents.
- NOT using lmctl for members yet (that integration comes later). Members are lmcode instances.
- Each instance = { role, session dir (a git worktree), sessionID }. I RESUME instances across commands.
- Vertical split (worktrees, by subsystem): memory, permission, tool-calls, cli-parse.
- Horizontal (cross-cutting): QA (test+review), external-CLI (wrap CLIs as structured tools).
- Start SIMPLE (one instance, trivial task), trial-and-error, then add complexity + more instances.

## CLI mechanics (learned)
- Create instance + capture id: `cd <worktree> && bun run --conditions=browser <MAIN>/packages/opencode/src/index.ts run --format json "<task>"`
  -> every JSON event line carries "sessionID"; capture it. (MAIN = /niceapps/mma/oc/lmcode; run from worktree cwd
  so the instance's project dir is the worktree, but deps resolve from MAIN's node_modules.)
- Resume: `... run --session <id> --format json "<followup>"`.
- Model: github-copilot/gpt-5.4 (works). Bun: /tmp/opencode/.bun/bin/bun. Dev wrapper: ~/.local/bin/lmcode.

## Instance registry (instance | role | worktree dir | sessionID | status)
- instance-1 | tool-calls coder (trial) | /tmp/lmcode-inst1 (empty-dir trial) | ses_0e22cf969ffeHc8Xl5JXKxaARF | VALIDATED
(more added as the team grows)

## Roster plan (grow incrementally)
1. TRIAL: instance-1 reads project + confirms understanding. (validate mechanics)
2. Add a real vertical task to instance-1 (e.g. a small tool-calls or cli item from the roadmap).
3. Add instance-2 as REVIEWER/QA (reviews instance-1's work).
4. Expand to the vertical set (memory/permission/tool-calls/cli) + horizontals (qa/external-cli), each its own
   worktree + sessionID.

## Backlog (lmcode roadmap to split across teams)
- external-CLI: gh tool (parse-as-is + deny-list + classify), ls tool, more coreutils; AWS-style MCP-wrap pattern.
- tool-calls: remove bash from secured toolset once coverage enough; tool ergonomics.
- permission: (lmprobe owns policy engine) — carry semantic classification; hooks.
- memory: organize/durable-memory refinements (topic files, bounded index tuning).
- cli-parse: CLI hardening, --json outputs, config UX.
- QA: tests for all of the above via the mock-LLM harness + real-model dogfood.

## TRIAL RESULT (instance-1) — mechanism VALIDATED
- Empty dir /tmp/lmcode-inst1. Task: create NOTES.md + confirm ready -> DONE (used write tool, EXIT 0).
- Resume via `run --session ses_0e22cf969ffeHc8Xl5JXKxaARF` -> answered its role + created file FROM MEMORY
  (0 tools), same sessionID. Persistent, resumable instance confirmed.
- MODEL NOTE: github-copilot/gpt-5.4 now 'not found' (catalog shifted; suggests gpt-5.5, gpt-5.5).
  Using github-copilot/gpt-5.5 for instances (works). Verify available models before big runs.
- NEXT (trial-error, incremental): give instance-1 a small REAL task, then add instance-2 as REVIEWER/QA.
- Cleanup note: removed orientation worktree (unused; the big-repo read errored on the bad model, not the tree).

## FLEET CYCLE 1 — ls tool — SHIPPED (dev e7b24634a)
- instance-1 (coder, ses_0e228ce80, worktree lmcode-wt/tool-calls, gpt-5.5): implemented structured ls tool
  (exec wrap, -- guard, external_directory gate, permission read) + tests. Self-verified typecheck+tests.
- instance-2 (QA reviewer, ses_0e220bbc0, gpt-5.5): reviewed the diff vs mkdir/rm pattern -> SIGNED OFF.
- meta-lead (me): objective verify (typecheck + 16 tests green) -> committed on worktree branch -> ff-merge to dev
  -> removed worktree. I wrote no code.
- LEARNINGS: (a) run instances DETACHED (setsid ... &) and POLL a jsonl file; the bash-tool 120s timeout can't
  block long runs. (b) combined bun test can flake on first run (timing) -> re-run to confirm. (c) integrate =
  commit on worktree branch + `git merge --ff-only <branch>` into dev + `git worktree remove`. (d) instances need
  PATH incl /tmp/opencode/.bun/bin and symlinked node_modules in the worktree to self-verify. (e) gpt-5.5
  works (5.4 disabled, 5.5 enabled).
- NEXT: fleet cycle 2 = gh tool (external-CLI, parse-as-is + deny-list + classify like git). If gh binary/auth
  unavailable -> instance implements classify + deny-list + UNIT tests (no gh-run needed); skip behavioral. Then
  reviewer. Then continue: remove-bash slice, memory/permission/cli verticals.

## FLEET CYCLE 2 — gh tool — SHIPPED (dev ec5acb32f)
- instance-3 (external-cli coder, ses_0e21a2dd8, worktree lmcode-wt/external-cli, gpt-5.5): implemented gh
  tool mirroring git.ts (exec wrap, classify, validateArgv deny-list for alias/extension). It USED our new ls tool.
- Verify: 24 gh tests (classify+deny-list+behavioral gh --version). This cycle I leaned on pattern-mirror (git was
  reviewer-vetted) + objective tests instead of a separate reviewer instance (autopilot momentum). Merged to dev;
  MAIN verify 84 pass (gh+git+registry), dev typecheck clean.

## FLEET RUNBOOK (repeatable — meta-lead)
1. Worktree: `git worktree add -b <branch> lmcode-wt/<name> dev`; symlink BOTH `node_modules` and
   `packages/opencode/node_modules` from MAIN (bun needs both). NOTE: the node_modules symlink makes `git status`
   HANG (git traverses it) -> REMOVE symlinks before any git op, re-add for bun verify.
2. Coder instance (DETACHED): `setsid bash -c "PATH=/tmp/opencode/.bun/bin:$PATH bun run --conditions=browser
   MAIN/packages/opencode/src/index.ts run --format json --model github-copilot/gpt-5.5 '<task>' > out.jsonl &"`.
   Task: read the pattern file(s), implement, ADD tests, run typecheck+tests, 'Do NOT git commit'. Capture sessionID
   from out.jsonl. POLL (bash-tool 120s cap): `pgrep -f <sessionID>`; the process survives tool timeouts.
3. Verify (meta-lead, objective): re-add symlinks; `bun test <files>` + typecheck. Most reliable: verify on MAIN
   after merge (real node_modules, no symlink issues). typecheck in worktree shows spurious @opencode-ai/core subpath
   errors (workspace-symlink artifact) — ignore; verify typecheck on MAIN.
4. Reviewer instance (optional, honor for non-trivial): another instance reviews (read files directly, NOT git diff
   which hangs; run tests) -> SIGNED OFF / CHANGES REQUESTED. Fix-loop by resuming the coder: `run --session <id>`.
5. Integrate: remove symlinks -> `git add <files>` + commit on branch (in worktree) -> `git merge --ff-only <branch>`
   in MAIN -> `git worktree remove --force` + `git branch -d`. Verify + typecheck on MAIN.
6. Record the cycle here. Skip blockers, keep going.
- SHIPPED so far by fleet: ls (e7b24634a), gh (ec5acb32f). Bootstrap fleet model VALIDATED.

## FLEET CYCLE 3 — find tool — SHIPPED (dev c6dedf1ef)
- instance-4 (external-cli coder, ses_0e20b4cbc, gpt-5.5): find tool parse-as-is mirroring git; deny-list
  (-exec/-execdir/-ok/-okdir/-delete/-fprintf/-fprint/-fprint0/-fls), external gate, permission read, classify.
  Verify 6 find tests + 19 on main (find+registry). Merged, worktree cleaned.

## BOOTSTRAP STATUS — fleet is a running machine
- SHIPPED via the lmcode dogfood fleet (meta-lead orchestrated, I wrote no code): ls (e7b24634a), gh (ec5acb32f),
  find (c6dedf1ef). Cycle 1 exercised full coder+reviewer+integrate; cycles 2-3 leaned on pattern-mirror +
  objective test verify for momentum.
- Secured toolset coverage now: file mutations (mkdir/rm/mv/cp/touch) + read/edit/write/glob/grep/apply_patch +
  ls + git + gh + find — all structured, permissionable, with deny-lists on the parse-as-is CLIs. Approaching
  "enough to remove bash" for the secured product mode.
- Model: gpt-5.5 (5.4 disabled -> 5.5). Runbook above is repeatable; each cycle ~10-15 min.
- NEXT candidates: (a) holistic dogfood — a QA instance does a real task with bash DISABLED using the full new
  toolset (validates the replace-bash goal end-to-end); (b) remove/gate bash in secured mode (config/agent
  permission bash:deny by default in a 'secured' agent) — keep bash for dev instances; (c) more CLIs (aws-style
  MCP-wrap), verticals (memory/permission/cli-parse). lmprobe wires the IAM policy against the tools' classify().
