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
