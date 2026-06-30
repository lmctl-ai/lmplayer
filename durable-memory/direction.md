# lmcode — Architectural Direction (operator north star)

Operator-stated direction for what lmcode is. Use this to judge design decisions.

## What lmcode is
- HALF a CLI for an LLM/agent to drive (plain commands, machine-readable output).
- HALF a microservice with a REST endpoint (`serve`), but SINGLE-USER: all requests are
  QUEUED and processed SEQUENTIALLY (one at a time). No multi-tenant concurrency.
- Everything the GUI/TUI did must be reachable via CLI commands + editable config files
  (with a `config verify` step). TUI kept but not default.

## Hard requirements
1. PERMISSIONS ARE FILE-BASED. No interactive user permission popup, ever. Permission
   decisions come from config rules (allow/deny/ask resolved from files). In agent/microservice
   use there is no human to answer a popup, so "ask" must not block — it resolves from config
   (or a safe default), never an interactive prompt.
2. STANDALONE CONFIG. lmcode must NOT merge config from parent or sibling directories.
   Today the loader walks up from cwd to the worktree root merging `opencode.json(c)` and
   `.opencode/` along the way (plus remote/managed/org layers). lmcode should use only its OWN
   config — the global config (and at most the single explicit project dir), with NO upward/
   sibling discovery/merge. (Relevant: packages/opencode/src/config/paths.ts walk-up discovery,
   config.ts merge order; see config-cli.md for the precedence layers.)
3. Single-user sequential execution for the server/microservice mode (serialized request queue).
   Aligns with the V2 SessionExecution serialized-runner design (see CONTEXT.md / AGENTS.md V2 notes).

## Near-term tasks implied (not yet done)
- Standalone config: disable parent/sibling config discovery+merge; load only global (+ explicit
  project) config. Add tests. (Concrete, bounded — good next task.)
- File-based permissions, no popup: ensure every mode resolves permissions from config rules with
  no interactive prompt; make "ask" non-blocking (resolve to a configured default) in CLI/serve.
- Microservice queue: `serve` already exposes REST; ensure single-user sequential queuing of
  prompts/requests (one active run at a time). Larger feature; design against SessionExecution.

## Done that supports this direction
- Default command sends a prompt (not TUI); `lmcode tui` explicit.
- Config is editable + has `config get/set/unset/verify`.
- Models/effort/auth are all CLI-discoverable.

## Progress on the direction
- DONE: standalone config (no parent/ancestor merge) — commit d66fb70c7 (paths.ts).
- DONE: file-based permissions, no popup — commit b1f0e9612. Config field `permission_ask: deny|allow`
  (default deny) collapses any residual "ask" at the V1 permission `ask` funnel (the live path for
  run/serve) to the fallback; explicit allow/deny still honored; nothing blocks on a human. V2 core
  permission left unchanged (not on the run/serve live path). Verify covers the field.
  - Live permission path = V1 (`packages/opencode/src/permission/index.ts`), reached via
    SessionPrompt.loop + V1 tools (ctx.ask). V2 (`packages/core/src/permission.ts`) NOT reached by run/serve.
- NEXT: single-user sequential request queue for `serve` (one agent run at a time, FIFO). Research the
  serve prompt-execution path + where concurrency happens before implementing.
- OPTIONAL: repo-side claude fix so claude-via-copilot works out-of-the-box (route via @ai-sdk/github-copilot
  in models.ts) — currently works via the user config override in ~/.config/lmcode/opencode.jsonc.
