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
- MODEL NOTE: github-copilot/gpt-5.4 now 'not found' (catalog shifted; suggests gpt-5.3-codex, gpt-5.5).
  Using github-copilot/gpt-5.3-codex for instances (works). Verify available models before big runs.
- NEXT (trial-error, incremental): give instance-1 a small REAL task, then add instance-2 as REVIEWER/QA.
- Cleanup note: removed orientation worktree (unused; the big-repo read errored on the bad model, not the tree).
