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
