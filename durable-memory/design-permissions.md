# Design: lmplayer Semantic Permissions (settled with operator)

## CURRENT MODEL — re-engineering clarification (operator 2026-07-07)
TWO modes. Precise control is a SEPARATE MODE, not a restriction baked into the tools.

1. DEFAULT = CODING (like opencode): permissive. General shell (bash) ON. **Native tools (`tool/linux/*`) are
   the SAME PERMISSION TIER as the shell** — equally broad. In coding mode a native tool must NOT be more
   restricted than bash.
   - BUG (the wfm81 `external_directory` asymmetry): LINTOOLS added `external_directory` folder-gating to native
     tools "mirrored from write/edit" — so `ls`/`cp` are workspace-confined while bash reads anywhere. That makes
     native tools STRICTER than shell in coding mode = wrong. FIX: in coding/default mode native tools match the
     shell's reach (drop the extra folder-gate; keep the sensitive-file guard). Also `rg` bypasses the gate that
     `ls`/`cp` enforce — inconsistent; unify all native tools to the same (shell-tier) policy.

2. PRECISE CONTROL = SECURED mode (e.g. production troubleshooting — the "run where Claude Code can't" value):
   - DISABLE the general shell (bash off).
   - Allow ONLY certain native tools, restricted to their SPECIFIC OPTIONS (per-tool AND per-flag/option allowlist
     — finer than verb/resource; the engineer declares exactly which tools + which options are permitted).
   - OR write our own WRAPPER around native tools (the MCP-WRAPPED form: declared, typed tool calls).
   - **lmprobe is THE EXEMPLAR of a precise-control tool** (read-only, bounded operations) — model the
     wrapped/precise approach on it.
   - Enforced by the IAM-style, engineer-authored, default-deny policy; per-agent + per-session (secured agent).

Net: coding mode → native tools == shell (broad); secured mode → no general shell, allowlisted native tools +
specific options, and/or wrappers. The per-folder / verb-resource scoping lives in SECURED mode, not the default.

## Philosophy
- AWS IAM-style: precise, declarative policy authored by an ENGINEER / company policy. The END USER never
  deals with security. Default-deny: not explicitly allowed = blocked.
- Value prop: because capability is precisely bounded, lmcode can run where Claude Code can't (e.g. a
  production server for troubleshooting) — you define exactly what's allowed.
- NO regex for the user. Semantic verbs x resources.

## Unit of control = THE TOOL CALL
Everything an agent does is a tool call: native tools, MCP tools (tool calls via plugin), and external CLIs
(currently via bash) are all tool calls. Bash is the uncontrolled escape hatch -> REMOVE it. Replace bash with
a small, curated list of coding tools, each a precisely-defined, permissionable tool call.

Two forms for external CLIs:
- PARSE-AS-IS: run the real binary (git, gh); parse the invocation -> (verb, resource); check. (parser carries
  the semantics.)
- MCP-WRAPPED: structure a large CLI surface into declared, typed tool calls (the AWS pattern: thousands of
  `aws` commands wrapped into an MCP server). Each wrapped tool declares its (verb, resource).
Unknown / unparseable / undeclared -> DENY. Nothing opaque executes.

## Policy model (IAM-style)
- Statement = effect(allow|deny) + action(verb) + resource(scope). deny wins. default-deny.
- Verbs: core resource verbs read / create / modify / delete, PLUS domain verbs (network, ...). Extensible.
- Resources (START COARSE/SIMPLE, refine later):
  - files -> FOLDER (directory scope). fits coding.
  - git/gh -> REPO NAME.
  - network -> ALL (coarse on/off).
- Classification (map an action -> (verb, resource) to check):
  - native file tools (read/edit/write) -> (verb, folder) directly.
  - parsed CLIs (git, gh) -> parse args -> (verb, resource).
  - MCP/custom -> declared per-tool manifest (verb + resource-kind), engineer-authored in lmcode's policy
    (trust boundary is lmcode's declaration, NOT the MCP server's self-description).
  - unknown -> deny.

## Start VERY SMALL (first slice — confirm toolset)
- Remove the raw shell/bash tool from the secured toolset.
- Keep native file tools, permissioned by folder (read/create/modify/delete).
- Add git + gh as parse-as-is capabilities with (verb, resource) parsing.
- Policy file (engineer-owned) with IAM-style statements; default-deny; end-user-invisible.
- Integration-testable via the mock-LLM harness (test/lib/cli-process.ts + TestLLMServer).

## Separation of concerns
- POLICY (engineer-owned config) vs RUNTIME (agent operates inside it). Keep them cleanly separate.
- This is the SECURED mode; the current permission funnel (file-based deny/allow) is the enforcement point to
  build on.

## LINTOOLS iteration (bash replacement toolset) — progress
- LINTOOLS-1 DONE (d38fb73da): structured mkdir/rm/mv/cp/touch under src/tool/linux/ (+exec.ts helper),
  wrap real coreutils via ChildProcessSpawner with TYPED params (no shell). Security: `--` before path operands
  (flag-injection defense) + external_directory gating mirrored from write/edit (cp gates source read+external,
  dest edit+external). Registered in registry.ts. Tests test/tool/linux/linux.test.ts (behavior + `--` + external
  gating; 30 pass). Bash still present (iterating). Reviewer1 signed off.
- Pattern to reuse for next batches: exec.ts (spawn real binary, structured params, `--` before operands,
  external_directory assert then ctx.ask). Existing tools already cover read/edit/write/glob/grep/apply_patch.
- NEXT ITERATIONS (planned):
  - LINTOOLS-2 read/listing: `ls` (directory listing — not covered by glob), + maybe cat/head/tail/wc (some overlap
    with read tool). verb=read, low risk.
  - LINTOOLS-3 GIT (parse-as-is, flagship of the well-known-CLI approach): structured git tool that runs real git
    and PARSES subcommand -> (verb, resource): status/log/diff=read, add/commit/checkout=modify, push=network+repo,
    pull/fetch=network+modify, rm=delete. Start with common subcommands.
  - LINTOOLS-4 GH (parse-as-is): gh pr/issue/repo -> (verb, resource) incl. network+repo.
  - Then POLICY ENGINE (IAM statements, semantic verbs read/create/modify/delete + folder/repo/network, default-deny,
    engineer config) wired at the Permission.ask funnel (permission/index.ts) reusing core/src/policy.ts evaluate.
  - Then REMOVE bash from the secured toolset (registry or agent permission bash:deny) once coverage is sufficient.

## LINTOOLS-3 (git) DONE + REAL-MODEL DOGFOOD (committed)
- git tool (a6072060c) + title cosmetic fix (24ea5d414). Reviewer1 signed off.
- COPILOT DOGFOOD (bash disabled via config {tools:{bash:false}, permission:{read/edit allow, bash deny}}):
  ran `lmcode run --model github-copilot/gpt-5.4` on a real task (mkdir src; write src/greet.py; git add; git
  commit) in a temp repo. The real model completed the ENTIRE task using ONLY the structured tools (mkdir, touch,
  write/patch, git) with NO bash — file created + committed (2e7f44f). Proves the secured toolset is sufficient
  for real coding. (Lesson: run from the TARGET cwd; a first run from packages/opencode accidentally committed to
  the lmcode repo — cleaned up via reset.)
- OBSERVATION: the model sometimes prefixes args with a redundant "git" thought, but passed correct args (the
  double-"git" was only a title cosmetic, now fixed). Consider: git tool description should state args EXCLUDE the
  leading "git"; optionally strip a leading "git" token defensively. (minor, iterate.)
## REMAINING ITERATIONS: gh tool (parse-as-is), ls (read), then lmprobe wires the IAM policy engine + we remove
## bash from the secured toolset once coverage is enough. Then dogfood other projects.

## STATUS 2026-07-04 — V2 permission_ask fallback dogfood fix
- Team lead: permissions. Worker session `ses_0d0fe3071ffeKum5HSAq4JPCRY` on worktree `/niceapps/mma/oc/lmcode-wt/perm-yolo`, branch `team-perm-yolo`.
- Worker commit: `f71812d96 fix(core): honor permission ask fallback`.
- Shipped behavior: V2 config now accepts top-level `permission_ask: "allow" | "deny"`; residual/unmatched `ask` decisions collapse to that explicit fallback before `assert()` can emit `permission.asked` or block. Unset fallback preserves current default `ask` behavior. Explicit allow/deny rules still resolve before fallback, so deny still wins over an allow fallback.
- Migration: V1 `permission_ask` is carried into V2 `permission_ask`.
- User allow-all config: `{ "permission_ask": "allow" }`.
- Verification: worker and lead both ran `cd packages/core && bun run typecheck` and `cd packages/core && bun test test/permission.test.ts test/config/config.test.ts` successfully (`29 pass, 0 fail`).
- SDK/client regen: not needed; no public Protocol or Server HttpApi changed.
- Notes: `bun.lock` was modified incidentally by install in the worker worktree and intentionally left unstaged/uncommitted per harness rules. No escalation.

## STATUS 2026-07-04 — Built-in `secured` agent dogfood
- Team lead: secured-agent. Worker session `ses_0d0c7f44bffeu9G8vKlkLBQTXG` on worktree `/niceapps/mma/oc/lmcode-wt/secured-agent`, branch `team-secured-agent`.
- Commits: `7ea494008 feat(core): add secured built-in agent`; `6a063d6f1 fix(core): expand secured agent tools`; `b75918356 fix(core): clarify secured agent prompt`; `4cf23c984 fix(opencode): load secured built-in agent`; `a953fdb63 fix(opencode): restrict secured git permissions`; `701b1ae36 fix(opencode): guard secured sensitive operands`.
- Shipped behavior: built-in zero-config `secured` primary agent exists in both Core V2 and legacy/opencode runtime, so `lmcode run --agent secured ...` resolves without config. Default `build` agent remains unchanged and still has bash.
- Design: chose (b), deny-by-default whitelist, because this is a security/deployment profile. No secured rule uses `ask`; unknown actions are denied. External directories and bash are deterministic deny.
- Safe allow-list: `apply_patch`, `cp`, `curl`, `edit`, `find`, `git` read-ish subcommands, `grep`, `glob`, `ls`, `mkdir`, `mv`, `read`, `rg`, `skill`, `tar`, `todowrite`, `touch`, `unzip`, `webfetch`, `websearch`, `wget`, `write`.
- Secret handling: `.env`, `.env.*`, and `secrets` paths are denied for direct reads and now also surfaced into permission asks for legacy structured search/archive tools (`rg`, `find`, `tar`, `unzip`) so secured denies them before execution.
- Proof no prompts: tests assert secured permissions contain no `ask`; representative permission/service evaluations for safe tools, bash, external_directory, .env, and secrets return allow/deny only; `service.list()` stays empty after secured evaluations.
- Verification by worker and lead: `packages/core && bun typecheck`; `packages/core && bun test test/agent.test.ts test/permission.test.ts test/session-runner-tool-registry.test.ts test/tool-bash.test.ts test/tool-read.test.ts`; `packages/opencode && bun typecheck`; `packages/opencode && bun test test/agent/agent.test.ts test/tool/registry.test.ts test/tool/linux/git.test.ts test/tool/linux/rg.test.ts test/tool/linux/find.test.ts test/tool/linux/tar.test.ts test/tool/linux/unzip.test.ts test/tool/linux/ls.test.ts`.
- Smoke: branch-local `bun run --conditions=browser packages/opencode/src/index.ts run --format json --model github-copilot/gpt-5.5 --agent secured "Use bash to run pwd..."` produced no fallback warning, no bash tool call, and response `Bash is unavailable.`
- SDK/client regen: not needed; no public Protocol or Server HttpApi changed.
- Notes: `bun.lock` was modified by worker worktree install and intentionally left unstaged/uncommitted. No merge to `dev`, no push, no PR. Escalations: none remaining; review found and worker fixed runtime agent registration, read-ish git policy, and sensitive operand gaps.
