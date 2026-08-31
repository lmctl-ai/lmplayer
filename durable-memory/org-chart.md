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

## OBSERVABILITY PROJECT — CLOSED (all 4 slices on dev)
- slice1 session report (7f1d92535), slice2 session health (82493138a), slice3 compaction.mode organize|summary
  (e71d2f786), slice4 measurement harness (dcef0d02f) + durable-memory/finding-organize-vs-summary.md.
- KEY FINDING (deterministic mock harness, worker ses_0daa51122): organize 3862->482 tok (87.5% reduction),
  needle RETAINED=yes; summary 3862->420 tok (89.1%), needle RETAINED=NO. => organize keeps slightly more context
  but does NOT lose the injected needle; summary compresses marginally more but LOSES it. Empirically justifies
  organize-as-default. QA caveat: measured via direct SessionCompaction.process, not full CLI auto-overflow.
- TEAM MODEL PROVEN: one team-lead (ses_0df62c098) delivered a full 4-slice project via workers, with meta-lead
  only seeding/coaching/independently-verifying/merging. Each slice: seed/resume lead -> lead drives worker in own
  worktree -> lead verifies+integrates on team branch -> meta-lead re-verifies -> merge to dev.

## ACTIVE PROJECT — QA bash-free validation (team-lead seeded)
- Fresh QA team-lead seeded (log /tmp/lead-qa.log). Goal: worker does a REAL multi-step engineering task with BASH
  DISABLED (worktree-local .opencode/opencode.jsonc harness denies bash), using ONLY the 15 structured linux tools
  + read/write/edit. PRIMARY deliverable = catalog of tool GAPS (missing CLIs/flags/workflows) ->
  durable-memory/finding-bash-free-validation.md. Validates the replace-bash thesis end-to-end + feeds next CLI
  vertical. When green, meta-lead merges any real code (not harness files) -> dev.
- STILL DEFERRED / TO ESCALATE when it next blocks: trusted-execution policy for bun/npm/pnpm/yarn/docker (tools
  that run untrusted code) — gates both more CLI coverage and the permissions engine. Consequential; get operator
  input before wrapping those.

## QA bash-free validation — CLOSED (dev 80d22c0af)
- Worker ses_0da68a0bcffeGp4kpBEh0XFMVs added structured `wc` tool + tests bash-free (tools.bash:false +
  permission.bash:deny harness), committed via read/grep/apply_patch/git ONLY. Thesis holds for edit/search/git.
  Meta-lead re-verified (typecheck + 140 linux tests) and merged wc + finding-bash-free-validation.md.
- GAP 1 (empirically confirmed, CONSEQUENTIAL -> escalate): with bash disabled the worker could NOT run `bun test`
  / `bun typecheck` (verification) nor `bun install` (deps) — no structured test-runner/package-manager tool.
  These execute untrusted repo code => need a trusted-execution POLICY. This is THE blocker to fully retiring bash.
  Draft proposal: durable-memory/design-trusted-execution.md (options for operator to decide).
- GAP 2 (concrete tool bug, autopilot-able): structured `git` tool (tool/linux/git.ts) has NO `workdir` param, so a
  lead operating in a worktree must fall back to raw commands to avoid acting on the main checkout. Likely applies
  to the other exec-wrapped linux tools too. Fix: add a scope-constrained optional workdir to exec.ts wrappers.

## TOOL WORKDIR FIX — CLOSED (dev 34ff25fca)
- Tools lead ses_0d59b9dbd drove worker: added `Workdir` schema + `resolveWorkdir(root,workdir)` (confines to
  workspace root, throws on `..` escape) across exec.ts + git/gh/find/rg/tar/unzip, classify reflects scope,
  tests (runs-in-workdir + rejects-escape). Meta-lead re-verified (142 linux tests + typecheck) and merged.

## FEATURE REQUEST (lmchat room "lmcode" seq1) — lmcode<->lmctl token integration (ACTIVE)
- Ask: lmctl `health` shows n/a context-size for lmcode members (codex/claude show it); lmcode must surface a
  per-session cumulative token total an external reader can pick up. Operator: "useful when we integrate lmcode
  to lmctl" -> make lmcode a first-class provider.
- ROOT CAUSE (explored): the total ALREADY EXISTS — SQLite `session` cols tokens_input/output/reasoning/
  cache_read/cache_write (packages/core/src/session/sql.ts:43-48), exposed on Session.Info.tokens, DB at
  ~/.local/share/lmcode/opencode.db (WAL). BUG: applyUsage (projector.ts:90-110) increments them ONLY on the
  legacy V1 PartUpdated step-finish path (projector.ts:312-329); the V2 runner Step.Ended projection
  (projector.ts:381-382) writes only per-message draft.tokens and does NOT roll up -> V2 sessions show stale/zero
  total = the n/a. Fix = make V2 Step.Ended maintain the cumulative cols (reuse applyUsage, guard NO double-count).
  NO wire-schema change, NO SDK regen (reuse existing tokens field).
- ACTIVE: tokens-integration lead seeded ses_0d4f499c4 (log /tmp/lead-tokens.log). Deliver fix + no-double-count
  test + durable-memory/integration-lmctl-tokens.md (read contract). Posted root-cause + proposed read contract to
  lmcode room (seq2): primary=read SQLite session.tokens_* cols read-only keyed by id; alt=GET /session/:id .tokens.
  Asked lmctl-src to confirm shape. When green, meta-lead merges -> dev + finalize the contract doc + post to room.
- SEED/RESUME COMMANDS (reuse): seed new lead = setsid bash -c '... run --format json --model
  github-copilot/gpt-5.5 "$(< /tmp/task.txt)" > log 2>&1' &  ; resume same lead = add --session <leadID>. Always
  file-based prompt (no backticks in the bash -c string). Check: grep -c "command not found" log (want 0).

## TOKENS-INTEGRATION — CLOSED (dev f937b8c2d)
- Worker ses_0d4f3bfa0: V2 Step.Ended now maintains persisted session.tokens_* via applyUsage delta-vs-prior
  (idempotent: duplicate/orphan Step.Ended net zero; V1 path untouched). No schema change, no SDK regen.
  durable-memory/integration-lmctl-tokens.md contract shipped. Meta-lead re-verified (core typecheck + 10 tests) +
  merged. Posted root-cause+contract to lmcode room seq2. => lmcode now surfaces real per-session token totals for
  lmctl health (read SQLite session.tokens_* at ~/.local/share/lmcode/opencode.db, or GET /session/:id .tokens).

## OPERATOR Q&A (durable-memory + file-based permissions)
- DURABLE-MEMORY: WORKING + on by default in lmcode. durable-memory.ts (index.md at data/session/<id>/
  durable-memory/), injected as authoritative system context EVERY turn (prompt.ts:1264-1283), OUTSIDE the lossy
  message pipeline => non-compacting; organize mode rewrites+preserves it (compaction.ts:422-500) with graceful
  stale-fallback. GAP: write path is indirect — only the LLM organize pass at compaction OR session import writes
  index.md; NO on-demand write tool/CLI/API. A session that never compacts never gets one. Follow-up candidate:
  add a durable-memory write tool so model/user can seed/update memory directly.
- FILE-BASED YOLO PERMISSIONS: root-caused. Two stacks; legacy V1 `permission_ask:"allow"` is SILENTLY IGNORED by
  the live V2 stack (migrate.ts drops it) -> that's why YOLO still prompts. WORKS TODAY via native V2 catch-all:
  {"permissions":[{"action":"*","resource":"*","effect":"allow"}]} (findLast, appended after defaults, beats the
  default external_directory/.env "ask" rules) -> deterministic, no prompts. FIX SEEDED: permissions lead
  ses_0d0ff4eb8 -> honor a config-level ask-fallback in V2 evaluator + migrate legacy permission_ask; preserve
  default (unset=ask) + deny-still-wins. When green -> meta-lead merges -> dev.

## PERMISSIONS YOLO FIX — CLOSED (dev 46d86b4f2) + MODEL SELECTION verdict
- Worker ses_0d0fe3071: V2 config now honors top-level `permission_ask` fallback (evaluator collapses residual
  "ask"->allow|deny); migrate.ts maps legacy v1 permission_ask -> v2 fallback. Tests: deny-still-wins over allow
  fallback, unset=ask preserved, migration. Meta-lead re-verified (core typecheck + 29 pass) + merged. => file-based
  non-interactive permission now works two ways: (a) top-level {"permission_ask":"allow"} OR (b) native V2 catch-all
  {"permissions":[{"action":"*","resource":"*","effect":"allow"}]}. Aligns with operator's "predefine security,
  never ask" + the semantic IAM design (design-permissions.md).
- MODEL SELECTION: SOLVED (verified empirically: `run --model github-copilot/gpt-5.5 --effort high` -> "build ·
  gpt-5.5 · high" -> PONG, ZERO config). Models auto-resolve from bundled models.dev catalog on any authenticated
  provider (provider.ts:1313-1636, getModel 1777-1799); `--effort` is an alias of `--variant` (run.ts:212-217),
  variants auto-generated per catalog model (provider.ts:1606-1608). Config only needed for genuinely NEW/unknown
  providers/models or custom variant tiers - exactly as intended. No opencode-style pre-declaration required.
- DURABLE-MEMORY (operator confirmed design, not a gap): the "no-compaction=>no-index" case is fine (all context is
  in the raw session, no loss). Per-session feature currently has the index.md level only; the "individual files"
  second level exists in the meta-lead repo memory but is NOT yet in the per-session data-dir feature -> optional
  future enhancement if wanted.

## SECURED AGENT (convenience profile) — ACTIVE (lead ses_0d0c8d360)
- Operator approved a built-in `secured` agent: zero-config non-coding/production profile. Requirements: bash OFF,
  DETERMINISTIC/NON-INTERACTIVE by construction (ruleset NEVER yields "ask" -> no prompts to misconfigure), safe
  defaults (deny bash + external_directory + .env/secret reads -> deterministic deny not ask; allow safe structured
  + read/edit tools). Built-in in packages/core/src/plugin/agent.ts (alongside build/explore/plan); scoped per
  session via --agent secured (agent is a per-session column). Default build agent unchanged (bash stays on).
- Design choice flagged to lead: prefer (b) deny-by-default whitelist (mirror `explore` agent) for a security
  profile over (a) allow-then-deny; escalate the exact allow-list if ambiguous. Rationale (operator): production
  boxes config without options; interactive permissions are error-prone -> predefine deterministic security.
- When green: meta-lead re-verifies (agent removes bash, no "ask", build unchanged) + merges -> dev. This makes the
  non-coding secured profile first-class: `lmcode run --agent secured` = bash-free, prompt-free, no config.

## SECURED AGENT — CLOSED (dev dce9bd884) + REFRAME: lmcode = CODING TOOL FIRST
- Operator reframe: lmcode's DEFAULT identity is a coding tool (enhanced opencode, BASH ON); we dogfood it as
  such (the fleet uses lmcode to build lmcode). "safe by default" is NOT the posture. `secured` agent = OPTIONAL
  opt-in profile only (bash-free, non-interactive, deny secrets/external-dir); do NOT gold-plate safety or make it
  default. Merged as opt-in; default build agent unchanged (bash on). Test: "never asks for secured permissions".
- NEXT (meta-lead recommendation): durable-memory ON-DEMAND WRITE TOOL. Confirmed NO write tool exists today
  (index.md only written by the organize compaction pass or session import). Adding a model/user-facing tool to
  read/write per-session durable-memory index.md on demand makes our FLAGSHIP differentiator actively usable during
  coding (agent curates its own persistent memory continuously, not only at compaction). Self-contained,
  autopilot-able, directly improves the coding dogfood loop. Alternatives: (2) make lmcode installable as a real
  binary for day-to-day coding use; (3) continuous dogfood-driven bug hunting. Awaiting operator pick.

## BACKLOG persisted + BATTLE-TEST DOGFOOD: svg-transit (ACTIVE)
- backlog/ dir committed on dev: README (index), svg-transit.md (full design), lmvideo.md (digest). Enhancements
  queued: durable-memory on-demand write tool; lmcode installable binary; dogfood-driven hardening.
- Operator directive: give lmcode a REAL, HARD greenfield project to battle-test it + surface issues. Project =
  svg-transit: a GENERIC SVG-domain visual transition engine (two SVG keyframes + duration + hints -> intermediate
  frames). Separation of concerns is the value (independent of diagramkit/lmvideo semantics). Creative core = the
  correspondence/matching + transition POLICY layer. Context: lmvideodev room (lmvideo requirements + zero-browser
  Rust arch); ../diagramkit (TS isomorphic CSP-safe SVG: geometry in attrs, semantic CSS classes).
- SETUP: NEW greenfield repo /niceapps/mma/oc/svg-transit (git, SPEC.md=design, README, .gitignore; commit 73ffc9d).
  Dogfood lead seeded ses_0cf7db799 (log /tmp/lead-svgtransit.log). Worker builds Milestone 1 (parse/flatten-
  transforms/match id->class->type+pos/classify move-resize-restyle-enter-exit/interpolate N frames linear+ease/
  CLI emitting SVG frames + deterministic snapshot tests) on branch milestone-1, cwd=svg-transit (bash ON - normal
  coding). DUAL deliverable: (1) svg-transit progress, (2) DOGFOOD-lmcode-findings.md catalog of lmcode friction/
  bugs/gaps hit while building (the real point of the battle test). Lead escalates matching-policy design ambiguity.
- WORKER SPAWN PATTERN for external repo: cd /niceapps/mma/oc/svg-transit && PATH=/home/mma/.bun/bin:$PATH bun run
  --conditions=browser /niceapps/mma/oc/lmcode/packages/opencode/src/index.ts run ... (lmcode operates on the
  external project). MONITOR: when lead reports, meta-lead independently reviews worker session + harvests lmcode
  issues into lmcode backlog/fixes, and reviews+merges milestone-1 -> svg-transit main.

## MODEL BALANCING (operator directive) — rotate copilot models across teams
- Verified working copilot models (smoke-tested PONG): claude-sonnet-4.6, gpt-5.3-codex, gemini-2.5-pro,
  gpt-5.5. Also entitled: claude-opus-4.8(/-fast), claude-opus-4.7(/-fast), claude-sonnet-5, claude-haiku-4.5.
  gpt-5.4 DISABLED.
- POLICY: do NOT run every worker on gpt-5.5. Balance across claude/codex/gemini/gpt. Updated team-lead-brief
  to rotate worker models from the roster. Meta-lead: assign VARIED models when seeding/resuming leads +
  rotating workers. Rationale: diversify strengths + dogfood surfaces model-specific lmcode issues + spread load.
- Running leads currently on gpt-5.5 (seeded before this): lmvideo ses_0cf6e683e, svg-transit ses_0cf7db799,
  (earlier project leads done). Enforce balance from next resume/seed onward.
- OPERATOR ASLEEP: FULL AUTONOMY. Do NOT wait for review. Keep dogfooding + autopiloting: review+merge on own
  judgment, keep fleet running with balanced models, harvest lmcode findings, maintain durable memory.

## AUTONOMOUS CYCLE (operator asleep) — first battle-test results MERGED + fleet rebalanced
- svg-transit Milestone 1 MERGED to svg-transit master (9c20b10): TS parse/flatten-transforms/match/classify/
  interpolate + CLI, 8 tests. Escalated design: matching needs a confidence threshold (over-matches).
- lmvideo e2e proof MERGED to lmvideo master (e9b2b0d): storyboard->lmsound(real narration)->timeline->ffmpeg
  mp4 + report.json, swappable renderer, PLAN.md (6 slices). Produced REAL mp4s. Screenshot scene = placeholder.
- DOGFOOD lmcode findings harvested -> backlog/lmcode-dogfood-findings.md. Top issues (BOTH teams hit #1):
  P1: git tool workdir rejects EXTERNAL repos; git `switch -c` false-positive in deny-list. P2: `branch
  --show-current` misclassified modify; glob ignores .gitignore (node_modules noise). P3: no structured
  session-tail tool / dense JSONL logs; shell-quoting fragility.
- ACTIONS (all fire-and-forget, BALANCED models):
  - toolfix lead ses_0cf5dd02d on gpt-5.3-codex: fix git switch -c + branch classify + glob gitignore + opt-in
    external workdir roots (in lmcode repo, branch team-toolfix). Meta-lead merges to dev when green.
  - svg-transit lead RESUMED ses_0cf7db799 on claude-sonnet-4.6: Milestone 2 = matching confidence threshold
    (below thresh -> crossfade not morph) + color-interp restyle + text bounds. Branch milestone-2.
  - lmvideo lead RESUMED ses_0cf6e683e on gemini-2.5-pro: next slice = SVG/diagram path integrating svg-transit
    (browser-free; deferred Playwright renderer due to host load). Branch TBD.
- ALL leads told the model-rotation policy so their workers diversify too. Meta-lead loop: verify+merge each
  green result to its master/dev, harvest new findings, resume next slice on a rotated model. No review-gating.

## STATUS CHECKPOINT (autonomous, operator asleep)
- MERGED: toolfix -> dev (all 4 dogfood bugs fixed: git switch -c allowed, branch inspect=read, glob honors
  .gitignore + includeIgnored opt-in, external workdir via config tool_workdir.extra_roots; 75+ tool tests green,
  no regen). svg-transit M1+M2 -> master (a795a3a: confidence threshold so unrelated shapes crossfade not morph,
  color interpolation, text bounds; 10 tests).
- lmvideo: e2e proof merged; SVG/diagram slice checkpointed as WIP (02e8a9f on svg-diagram-scenes). Lead RESUMED
  (gpt-5.5) to unblock: integrate svg-transit as a LIBRARY (file:../svg-transit, import createFrames) instead of
  CLI spawn (which hit the bun-PATH ENOENT), render the svg-diagram example -> mp4+report, commit.
- BATTLE TEST WORKING: loop = build real project -> surface lmcode bug -> fix lmcode. cycle-2 findings harvested
  (backlog): #7 subprocess spawn PATH (bun at non-standard /home/mma/.bun/bin); #8 claude-sonnet-4.6 32K output
  cap fails a big step (retry on codex succeeded) - lmcode should soft-land the cap.
- MODEL BALANCE active across fleet: toolfix=codex, svg-transit workers=claude+codex, lmvideo=gpt-5.5/claude.
- NEXT (autopilot): merge lmvideo svg/diagram slice when green; resume svg-transit M3 (split/merge, path morph,
  PNG encode); consider lmcode fixes for #7/#8. No review-gating.

## lmvideo svg/diagram slice MERGED (master 540ddcc)
- Integrated svg-transit + diagramkit as LIBRARIES (file: deps, direct createFrames/render - resolved the spawn
  PATH issue). Added svg->PPM raster handoff (host ffmpeg can't decode SVG directly - env finding). Rendered
  examples/svg-diagram.storyboard.json -> mp4 (22KB) + report + 27 svg-transit transition frames.
- NEW findings: (a) worker requested gpt-5.3-codex but RAN as gpt-5.5 -> model selection not always honored
  (undermines balancing; investigate). (b) ffmpeg SVG-decode gap -> PPM handoff (env/lmvideo, not lmcode).
- CHALLENGE now central: verifying OUTPUT QUALITY (visual transitions / video look-right / sync) - tests prove it
  RUNS not that it is GOOD; needs human/visual review. Plus host saturation+reboots + model reliability variance.

## AUTONOMOUS CYCLE 3 (info reqs answered; still autopiloting)
- MODEL FINDING (empirical, supersedes "gpt-5.5 only"): claude/gemini/codex are REAL DISTINCT models, usable
  CONFIG-FREE via --model github-copilot/<id> (each self-IDs correct maker/version). Earlier "ran as gpt-5.5"
  = lead spawn didn't pass --model (orchestration bug), not a fallback. gpt-5.5 fine default; can use per-role.
- lmprobe DOGFOODED + filed to lmprobedev seq2 + backlog/lmprobe-dogfood.md: glibc-2.39 floor blocks native run
  on this host (2.34) and only 0.42.1 published; WORKS in glibc>=2.39 container (node:24-trixie-slim); functional
  output is clean/structured (find/grep/def/ref/GraphQL); casing inconsistency; integration = back lmcode
  grep/glob/find + code-nav tool, guard glibc + rg fallback.
- svg-transit M3 VISUAL FIX merged to master (c8efd54): text crossfades not morphs, safe class matching, no
  ghosting - GATED BY gpt-5.5 VISUAL QA (rejected v1, accepted v2). 14 tests. The visual-QA loop (render->PNG->
  gpt-5.5 multimodal review) is VALIDATED - catches defects tests miss = the answer to the output-quality challenge.
- lmvideo USABILITY: usable today for simple SVG/diagram + crossfade + narration presentations (verdict merged
  a29429a). RESUMED lead to re-validate WITH the now-fixed svg-transit morphs -> upgrade verdict if morphs pass QA.
- cycle-3 findings harvested (backlog): visual-QA validated; need standard SVG->PNG rasterizer; failed-worker
  state residue across branch switch; long resumed-lead sessions need summarized-resume.

## lmvideo INSTALLED + HOW-TO (answering "usable/accessible anywhere")
- lmvideo is now a GLOBAL command: ~/.local/bin/lmvideo (wrapper -> bun on lmvideo/src/cli.ts, loads
  .lmctl-access for lmsound). Runs from ANY cwd (tested from /tmp -> output.mp4+report.json). Also installable
  via `bun link` (added package.json bin + repo bin/lmvideo). Committed lmvideo master a5af7da.
- HOW-TO: lmvideo/HOWTO.md (install/access, quick start, storyboard schema, output=mp4+report.json, QA frames via
  ffmpeg, honest caveats) + USABILITY.md (verdict + authoring workflow) + examples/presentation.storyboard.json.
- USABILITY reality (honest): usable for SVG/diagram + crossfade + lmsound-narration presentations, deterministic,
  reviewable report. NOT ready: real screenshots (placeholder), browser HTML/CSS (placeholder), burned-in
  captions, full SVG fidelity, svg_transit MORPHS (still rejected by presentation-context visual QA even after M3 -
  simple svg-transit fixtures passed but complex real slides still garble; crossfade is the recommended default).
- NEXT (svg-transit): morphs need robustness on COMPLEX real SVGs (component-level QA passed, integration-level
  failed) - the realistic test caught what unit fixtures missed. Crossfade meanwhile is production-usable.

## lmvideo USER FEEDBACK (wfm81, lmvideodev seq4) - FIXED + MERGED (master d240a9a)
- wfm81 did first real use: authored 5-scene narrated deck (3 voices) - validated core (installed/fast,
  storyboard-as-data, real lmsound 3-voice narration, audio-derived timing, SVG slides, report.json).
- Fixed their prioritized bugs: (1) render resilience - GET /voices preflight + default/synthetic fallback +
  warnings[], no whole-render abort on one bad voice; (2) visible placeholders for html/screenshot (not silent
  blank); (3) diagram theme/layout/caption - inherit theme, auto-fit+margins (no clip), render caption; (4) --qa
  flag auto-emits sample frames. Verified on examples/feedback-repro.storyboard.json + merged. Posted fixes-live
  to lmvideodev. Queued next: burned-in captions; svg_transit morph compositor hardening (still experimental).

## RENAME lmcode -> lmplayer + PACKAGED for lmctl (operator directive: "code" overloaded)
- Product renamed lmcode -> lmplayer. Centralized: global.ts app="lmplayer" + in-code migration (auto-moves
  legacy ~/.local/share|config|state|cache/lmcode -> lmplayer on first run, preserving auth). Swept CLI
  scriptName/ui/help/bin (bin/lmcode->bin/lmplayer, package.json bin). REPO DIR stays /niceapps/mma/oc/lmcode
  (renaming would break fleet worktrees/runbook); "opencode" internal names untouched. Committed (2 commits).
- Verified: source runs as lmplayer (dirs migrated, auth carried), typecheck clean.
- PACKAGED: single standalone bun-compiled binary (140MB, `bun run script/build.ts --single --skip-embed-web-ui`
  -> dist/opencode-linux-x64/bin/lmplayer). Installed ~/.local/bin/lmplayer. Headless run --format json = PONG.
- DISTRIBUTED to NEW lmplayerdev room: ONE package (seq3 lmplayer-linux-x64.gz, 46MB) + ONE install command
  (curl from room | gunzip > ~/.local/bin/lmplayer). Verified end-to-end fresh install from /tmp works (PONG).
  Install doc (seq4) documents lmctl provider interface: run --model <prov/model> [--session][--format json],
  config-free models, resumable sessions, serve mode.
- lmchat DELETE endpoint works (DELETE /rooms/{room}/files/{seq}) - used to clean up superseded uploads.
- FLEET NOTE: data dir is now ~/.local/share/lmplayer (brief updated). Fleet run cmd unchanged (repo path same).

## lmctl provider integration Q&A (lmplayerdev)
- lmctl-src asked 6 Qs (seq8) -> narrowed to 3 blockers (seq9): session store/discovery, resume, run --format
  json schema. Dropped model/effort (confirmed config-free), permissions (confirmed file-based), MCP (they're
  retiring MCP). Posted tested answers seq10. KEY FACTS for lmctl:
  - Session DB: the DISTRIBUTED BINARY runs channel="local" -> ~/.local/share/lmplayer/opencode-local.db (source/
    dev = opencode-dev.db). Override OPENCODE_DB=<abs>. WAL, read-only. Discover by session.directory==abs cwd;
    `lmplayer session ls [--json]` lists sessions for current cwd.
  - Resume: `run --session <id> "<msg>"` (msg required) or -c/--continue (last root in cwd); resume works from ANY
    cwd - execution pins to the session's stored directory (no cwd validation).
  - run --format json: JSONL, sessionID top-level on EVERY line -> capture from line1 (step_start). Types:
    step_start/text/tool_use/step_finish/reasoning/error; no terminal event (ends at idle). Current-turn-only: one
    run emits only that turn (collect type==text data.part.text, last = final).
  - YOLO per-run no-config: --dangerously-skip-permissions (or OPENCODE_PERMISSION env). No ancestor-dir config
    inheritance (standalone). Seed: lmplayer run --model github-copilot/gpt-5.5 --dangerously-skip-permissions --format json "..."
- Offered follow-up lmplayer tweaks: fixed DB name default + a terminal json event, if they want them.

## Autopilot session 2026-07-07 (operator asleep) — landed + pushed
- lmplayer PATCHED: merged 199 upstream opencode commits (sonnet-5 + latest models) -> dev, pushed lmplayer/dev
  (6c8b28821 merge, 94ba935cc). Judgment call: upstream migrated off `defaultLayer` to `.node`/LayerNode; dead
  defaultLayer exports dropped (zero consumers). Binary rebuilt+reinstalled (0.0.0-dev-202607070713) -> lmctl seed
  now works for claude-sonnet-5 (was failing on old binary).
- lmvideo: E1-E7 tree auto-layout (radial/tidy_tree/layered/force) + reveal + clock/metrics overlays + amber-pulse
  state, committed to master (a41d074, 99165c7). Gemini QA "ship w/ minor fixes" addressed.
- metrics side-project (foundation): `lmplayer session metrics <id> [--json]` (tokens+cost_usd+latency+tool
  counts+files created/modified; reads persisted store) shipped+pushed (48cf2f4e0). Contract filed lmplayerdev
  seq29 / lmctldev seq28 (lmctl to wire health to it).
- Workflow now: code->commit->review->push (push enabled to lmctl-ai/lmplayer). Teams: design council + per-project
  lmplayer-dev/lmvideo-dev + QA, all provider=lmplayer github-copilot. NEXT: org-metrics analyzer (reads sessions
  via session metrics + comms -> perf report); lmctl-side health wiring; other products (svg-transit, diagramkit).
- org-metrics ANALYZER (first slice): new repo /niceapps/mma/oc/org-metrics — `org-metrics report <teamfile>
  [--json]` aggregates `lmplayer session metrics` into per-member + org rollup (cost/tokens/files/tools/latency),
  reviewed (c969b11, 1eab5d6). No remote yet (local master). NEXT: communication-analysis slice; lmctl integration.
- Autopilot session END state: all operator priorities (lmvideo, patch lmplayer) + metrics side-project DONE.
  Fleet idle+healthy, ready for direction. Queued: org-metrics comms slice, other products (svg-transit,
  diagramkit-rs), lmctl-side health-wiring (their repo). Binary=0713, teams seeded, sonnet-5 works via lmctl.

## STATUS SNAPSHOT 2026-07-07 (end of long session)
LANDED+PUSHED to lmplayer/dev: upstream merge (sonnet-5+latest), run false-success fix (fd9f9c6af), TUI
resize-repaint+panel-hidden+re-enable (f1d158f51), session metrics (48cf2f4e0), models/verify, remote-poll
prototype (4ea42dbab), forced-delegation plan agent (4130f7129), ollama config-free+chat-only+`+tools`+verbose
logging (108b8bfdf/788cc54fc/a0d6c9b03).
ON BRANCH (verify+merge pending): lmplayer/lean-profiles = item-4 positive tool provisioning + lean qwen2.5
profile (6a2f51d2d). "provide only allowed tools" not "provide-all-then-deny".
STANDALONE REPOS (local, no remote): lmcatalog (model+price catalog, dual api_id + multi-provider, 90e9950);
org-metrics (per-member/org perf analyzer, c969b11); frontdesk (heartbeat+inbox CLI, 45ca0b5 — adopt as loop
heartbeat + file spec to lmctl).
FILED TO lmctldev (lmctl team): TUI launch on `lmctl terminal` (seq32/34 area), model-expression/plan grammar.
OPEN: dev behind origin/dev ~3 (upstream drift); merge lean-profiles->dev; adopt frontdesk.
KEY DESIGN (durable-memory): design-permissions.md (native==shell tier coding; secured=precise per-tool+option/
wrapper, lmprobe exemplar); lead-brief-lmctl.md (strong team roster + model routing + cost tiers: free ollama
chat-only for simple work); metalead-loop.md (delegate-not-groundwork; chatroom own-a-room-as-backlog; hard guard
never kill+reseed in one step).
