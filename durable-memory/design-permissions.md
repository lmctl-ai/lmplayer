# Design: lmcode Semantic Permissions (settled with operator)

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
