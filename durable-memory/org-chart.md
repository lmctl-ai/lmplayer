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

## FLEET CYCLE 4 — session ls/tail (WIP, on branch cli-session-cmds f3b439f16)
- instance-5 (cli-parse coder, ses_0e1eeeec2, gpt-5.5): implemented `lmcode session ls` (list sessions:
  id/title/dir/messageCount via sdk.session.list()+messages()) and `lmcode session tail <id> [-n N]` (last N
  messages via sdk.session.messages(limit)) in cli/cmd/session.ts. Mirrors lmctl ls/tail for fleet management.
- STATUS: code written + committed on branch cli-session-cmds; NOT yet typecheck/test-verified — the instance
  hung on self-verification and the HOST became externally saturated. VERIFY + ff-merge to dev when load subsides:
  cd worktree; re-add node_modules symlinks; `bun run typecheck`; run `session ls`/`session tail <id>`; then
  remove symlinks + `git merge --ff-only cli-session-cmds` in MAIN.
- ENV BLOCKER (not mine): host CPU saturated by EXTERNAL processes — java (155%), the real /usr/local/bin/opencode
  (106%), k8s, another claude. My lmcode instances were killed and are NOT the cause. Heavy commands (cold bun
  test/typecheck, big git scans) intermittently hit the 120s tool timeout; simple commands work. Skip heavy ops
  until load drops. Worktree lmcode-wt/cli left intact for pickup.

## FLEET CYCLE 4 — session ls/tail — SHIPPED (dev 661555110)
- `lmcode session ls [--json]` (id/title/dir/updated/messageCount) + `lmcode session tail <id> [-n N] [--json]`
  (last N messages). Verified: typecheck clean, both commands + --json functional on dev. This is the
  fleet-management tooling the meta-lead needed (replaces JSONL-grepping): `session ls` to see instances,
  `session tail <id>` to read an instance's history/result.

## RUNBOOK CORRECTION (worktree deps) — standard, not special
- Worktrees are INDEPENDENT: give each its OWN node_modules. DO NOT symlink (git follows it and hangs).
  Standard fix: `cd <worktree> && bun install` (uses bun global cache/hardlinks, ~20s, full workspace layout).
  A CoW copy (`cp -a --reflink=auto MAIN/node_modules WT/node_modules`) also works for the root but MISSES
  per-package deps (e.g. tui/solid-js) -> prefer `bun install`. A real gitignored node_modules keeps git fast.
- WAIT PROPERLY: `lmcode run` is synchronous and won't time out (lmctl default 8h). To wait interactively, set the
  bash-tool `timeout` param high (e.g. 300000). Or background `& > /tmp/f` + poll process EXIT (not event count).
  The printed response IS the result.

## OPERATING PRINCIPLE (internalized)
- Solve trivial/standard technical steps AUTONOMOUSLY (worktree deps, waiting, env). Do NOT frame them as blockers
  or ask the operator to pick an implementation. Escalate ONLY requirement-level / consequential decisions.

## PROJECTS QUEUED (autopilot backlog)
- P-external-cli (vertical): retire bash by covering common CLIs (more coreutils, parse-as-is/MCP-wrap, deny-lists).
  Clarify run launched (ses_0e1ae7887) but TIMED OUT under host load mid-exploration — RESUMABLE.
- P-observability (durable-memory/project-observability.md): `session report` (tokens/files/msg-size) + `session
  health` (context size, like lmctl health) + /organize-vs-/compact CONFIGURABLE (compaction.mode) + MEASURED
  (context reduction + needle-retention via mock harness). Validates the novel /organize with real numbers.
- Each project: clarify goal -> instance states understanding+plan -> sanity-review/nudge -> autopilot -> nudge +
  sanity-review. QA = find bugs, not gate.

## CONSEQUENTIAL OPERATIONAL CHALLENGE (escalate) — HOST SATURATION limits fleet throughput
- The shared host is CPU-saturated by EXTERNAL processes (measured: java ~155%, the real /usr/local/bin/opencode
  ~106%, k8s components, another claude). My lmcode instances are NOT the cause.
- Effect: model+local runs that should take ~1 min are exceeding 5-7 min or hitting timeouts (a simple external-cli
  CLARIFY/plan run exceeded 400s). This directly throttles running MULTIPLE concurrent autopilot instances — the
  near-term goal. It is outside my control (can't kill other tenants' processes).
- To run the multi-project autopilot fleet at reasonable speed, the host needs CPU headroom (or dedicated
  resources). Everything is captured/continuable (project specs, runbook, org chart, resumable sessions) so the
  fleet executes cleanly once there's capacity.

## AUTOPILOT RUNNING (fire-and-forget; check via session ls/tail + git log on branch)
- P-external-cli: ses_0e171f9fa, worktree lmcode-wt/external-cli, branch vertical-external-cli, gpt-5.5.
  Directive: implement SAFE parse-as-is CLI tools one at a time (rg, tar, curl, wget, unzip), each mirror git.ts +
  tests, self-verify (typecheck+tests), COMMIT each on the branch. DEFER bun/npm/pnpm/yarn/docker (untrusted code
  execution -> separate policy; writes NOTES-defer.md). Grinds slowly under host load — that's fine (no deadline).
  Sanity-review pattern: `git -C lmcode-wt/external-cli log --oneline`, spot-check a tool + tests, then merge the
  green branch to dev (regular merge; dev has advanced).
- P-observability: specced (project-observability.md) incl. small-compaction-trigger stress test. Ready to launch
  as its own autopilot instance (same worktree+bun install+clarify->autopilot pattern) when I cycle to it.
- FIRE-AND-FORGET PATTERN (for loaded host / no deadline): launch autopilot detached (setsid ... &), do NOT
  tight-poll; check infrequently via `lmcode session ls` / `session tail <id>` + branch git log; retry on crash.

## RESUME 2026-07-02 (post nightly-reboot) + TEAM PIVOT (hierarchical fleet)
- REBOOT RECOVERY: VM auto-shuts-down each evening to save cost; `/tmp` is WIPED. bun was in /tmp -> GONE.
  FIX (persistent): `BUN_INSTALL=/home/mma/.bun curl -fsSL https://bun.sh/install | bash` -> bun now at
  `/home/mma/.bun/bin/bun` (v1.3.14, survives reboot). Auth (~/.local/share/lmcode/auth.json) + all node_modules
  (on /niceapps) + git branches all PERSIST. Smoke test green (gpt-5.5 -> PONG). NEVER symlink node_modules.
- MERGED to dev after resume: external-cli batch `fe931ff74` (rg/tar/curl/wget/unzip = 15 linux tools total, 151
  tool tests pass) and observability slice-1 `7f1d92535` (`session report <id> [--json]`: tokens/duration/touched
  files; convention-matching, test green).
- TEAM PIVOT (operator directive): stop micromanaging individual workers; SEED a TEAM-LEAD instance (like lmctl
  `seed`, but simpler: no MCP, the `run` command IS the whole interface) and COACH it with my runbook so leads
  drive workers and I only manage leads. Coaching manual = `durable-memory/team-lead-brief.md`.
- SEED GOTCHA (learned): passing a prompt with backticks through `bash -c "... \"$VAR\""` triggers command
  substitution -> corrupts the prompt AND executes fragments. SAFE PATTERN: write prompt to a file, run via
  single-quoted body: `setsid bash -c 'cd MAIN && PATH=/home/mma/.bun/bin:$PATH bun run --conditions=browser
  packages/opencode/src/index.ts run --format json --model github-copilot/gpt-5.5 "$(< /tmp/task.txt)" > log 2>&1' &`
  ("$(< file)" output is NOT re-scanned for backticks). Verify no "command not found" in the log after seeding.
- TEAM-LEAD VALIDATED end-to-end: observability lead ses_0df62c098ffe6WO5RddN1jthJx drove worker
  ses_0df61b134ffeMRHwmbw3lO4n75 on `session health`, verified, integrated on team-observability, reported honestly
  (with a QA caveat: health is a token approximation, not exact next-turn projection). Meta-lead independently
  re-verified (typecheck + 2 tests green) and MERGED slice 2 `82493138a` (session health) -> dev. The
  lead-drives-worker recursion works with only seed+coach.
- OBSERVABILITY slices on dev: slice1 `session report` (7f1d92535), slice2 `session health` (82493138a),
  slice3 `compaction.mode` organize|summary flag (e71d2f786). Slice3 worker ses_0df3ede29ffeWb2uI5yhWfuJsA
  restored the historical lossy summary path behind the flag (organize stays default); did NOT need to escalate.
  Meta-lead re-verified (typecheck + 56 compaction + 15 config tests) AND ran `bun run generate` (packages/client)
  -> NO drift, so config-schema change needs no SDK regen. Merged.
- ACTIVE: lead resumed (same session) on slice 4 = MEASUREMENT HARNESS (payoff): mock-LLM harness driving a
  session past a compaction trigger under both compaction.mode=organize and =summary; record post-compaction
  context size + needle-retention (inject MAGIC token early, assert survival), plus ~100K small-trigger STRESS
  variant (organize fires repeatedly, retained context stays bounded, index.md needle survives), plus a short
  written finding durable-memory/finding-organize-vs-summary.md. When green, meta-lead merges -> dev; that
  CLOSES the observability project. Reuse test/lib/{llm-server,cli-process,test-provider}.ts (no real providers).
- SEED/RESUME COMMANDS (reuse): seed new lead = setsid bash -c '... run --format json --model
  github-copilot/gpt-5.5 "$(< /tmp/task.txt)" > log 2>&1' &  ; resume same lead = add --session <leadID>. Always
  file-based prompt (no backticks in the bash -c string). Check: grep -c "command not found" log (want 0).
