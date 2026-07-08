# Changelog

All notable lmplayer-specific changes to this fork are recorded here. lmplayer
tracks upstream opencode and layers its own features (the lmcode→lmplayer
rename, Linux tool suite, session metrics/report/health, session-inspect,
compaction routing, file-based permissions, and the remote-poll channel
prototype) on top. Upstream opencode changes are summarized per refresh rather
than enumerated line by line.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- **Forced-delegation `plan` agent (backs the lmctl `model="<model>+plan"`
  expression).** The built-in `plan` agent is now a pure orchestrator: it can
  read, inspect, and plan, and it MUST delegate every change through the `task`
  tool, but it cannot mutate anything itself. `edit` is denied outright (which,
  because write/edit/apply_patch and the mutating native tools — mkdir/rm/mv/cp/
  touch and git/gh/tar/unzip writes — all evaluate under the `edit` permission,
  blocks and hides them), `bash` is denied, and the mutating native tools
  (`mkdir`, `rm`, `mv`, `cp`, `touch`, `tar`, `unzip`, `curl`, `wget`) are
  removed from the toolset by id — `curl`/`wget` ask under the `read`
  permission (so the `edit` deny alone would not block them) but can still
  write files (e.g. `curl -O`), so they must be denied by id too. Read/inspection
  tools (`read`, `ls`, `grep`, `rg`, `find`,
  `wc`, `glob`, `session_inspect`, and git read subcommands like status/log/diff)
  stay available. Crucially, `task` delegation — previously partly disabled under
  plan (`task.general` was denied) — is now fully re-enabled, and delegated
  subagents are NOT bound by the plan agent's mutation denies (those live in
  `agent.permission`, not session permission), so the delegated worker can make
  the actual changes. User `permission` config still overrides.
- **Config-free local Ollama via an extended model name (`ollama/<model>`).**
  You can now run `lmplayer run --model ollama/qwen2.5` (and `lmplayer models`
  / `lmplayer models verify ollama/qwen2.5`) with **no `opencode.json` and no
  API key** — mirroring how `github-copilot/<id>` works config-free. Ollama is
  not in the models.dev catalog (only `ollama-cloud`, which needs a key), so
  lmplayer now seeds a built-in, keyless, OpenAI-compatible `ollama` provider
  (`packages/opencode/src/provider/provider.ts`) pointed at ollama's own
  `http://localhost:11434/v1` endpoint. A curated seed list
  (`qwen2.5`, `qwen2.5-coder`, `llama3.2`, `llama3.1`, `mistral`) makes
  `models ollama` list something useful, and **any other tag is synthesized on
  demand** (`ollama/qwen2.5:7b`, `ollama/deepseek-r1`, …) so the model set stays
  as dynamic as `ollama pull`. **Extended-name (self-sufficient) scheme** for
  a non-default host, highest precedence first: (1) an in-name `@host` suffix,
  e.g. `ollama/qwen2.5@192.168.1.5:11434` (safe delimiter — ollama tags use
  `:` and namespaces use `/`, never `@`); (2) the `OLLAMA_HOST` env var
  (ollama's own standard var); (3) the `http://localhost:11434` default. Any
  host form is normalized to an OpenAI-compatible `/v1` base. Synthesized ollama
  models are flagged `toolcall:false` (see chat-only below). The built-in is
  additive and respects config: `disabled_providers`/`enabled_providers` opt it
  out, a user-configured `provider.ollama` with its own model list wins
  untouched, and a configured `provider.ollama` that only sets `options.baseURL`
  is seeded against **that** URL. It is deliberately excluded from `defaultModel`
  auto-selection (a user with no real provider still gets the actionable
  "no providers" path, not a silent default to a possibly-not-running local
  daemon) and from unfiltered `models --test` (run `models --test ollama`
  explicitly to probe it). Covered by offline unit/instance tests
  (`packages/opencode/test/provider/ollama.test.ts`): the `@host`/`OLLAMA_HOST`
  precedence, config-free `getModel`/`getLanguage` base-URL resolution through
  the real OpenAI-compatible SDK, on-demand tag synthesis, and the
  disabled/config/default-selection guards.
  **BUILT-BUT-UNTESTED (live-ollama path):** this host has no ollama installed,
  so the actual HTTP round-trip against a running `ollama serve` (real `/v1`
  streaming, real absence-of-`Authorization` behavior, real qwen2.5 output) has
  **not** been exercised end-to-end. The wiring, resolution, and base-URL
  plumbing are proven offline; an operator with local ollama should pull this,
  run `lmplayer run --model ollama/qwen2.5 "hello"`, and report/fix any live
  gaps.
- **Opt-in Ollama function calling with a `+tools` model suffix.** Local
  Ollama models remain chat-only by default (`ollama/qwen2.5`) so weak/simple
  models are not offered tools unless explicitly requested. To test a local
  model's native function-call behavior, use `ollama/qwen2.5+tools` or
  `ollama/qwen2.5+tools@host:11434`; lmplayer strips the suffix before sending
  the model id to Ollama but marks the model `toolcall:true`, routing it through
  the normal tool pipeline. Live probe from WSL to Windows Ollama at
  `http://172.18.32.1:11434` confirmed `qwen2.5:14b` returns valid
  OpenAI-compatible `tool_calls` with JSON-string arguments on
  `/v1/chat/completions`, and native Ollama `/api/chat` returns structured
  `message.tool_calls`. A bash-only lmplayer permission profile
  (`permission: {"*":"deny","bash":"allow"}`) also lets qwen2.5 reliably shell
  out through the `bash` tool; a live probe ran
  `lmctl chat "/home/mma/repos/lmplayer/lmplayer.lmctl" Coder "reply OK"` via
  bash and received `OK`.
- **Conditional chat-only mode for simple models (no tools offered).** Models
  flagged `tool_call:false` — which now includes every synthesized `ollama/*`
  model, and any other provider/model configured that way — are sent to the
  provider with **no tools at all** (empty/omitted), so a weak model
  (e.g. ollama qwen2.5) produces a plain **text** reply and can never emit the
  malformed tool-call JSON that breaks parsing. This is a _conditional_
  exception, not a global change: capable models (all `github-copilot` ones are
  `toolcall:true`) keep their **full, unchanged** tool set. The gate lives in
  `packages/opencode/src/session/llm/request.ts` (`prepare()`): when
  `capabilities.toolcall === false` the tool set becomes `{}` and the
  OpenAI-strict and Copilot `_noop` fixups are skipped; every non-chat-only path
  is byte-for-byte unchanged. The final assistant text flows cleanly to a
  control system via `--format json` (a `text` event carrying `part.text`),
  which is the intended use case (e.g. a translator member returns text; a
  control system decides done / has-issue / needs-escalation). Proven at the
  wire level offline (`packages/opencode/test/session/llm.test.ts`): a
  `tool_call:false` model with a real tool in the request still sends
  `body.tools === undefined`, while a `tool_call:true` control keeps its tools.
- **Verbose LLM file logging for debugging tool-call issues (e.g. qwen2.5).**
  A single switch, `LMPLAYER_LLM_VERBOSE=1` (or `true`), turns on detailed
  JSONL logging to a dedicated file, `<XDG_DATA_HOME>/lmplayer/log/llm-verbose.log`
  (`Global.Path.log/llm-verbose.log`), separate from the normal `opencode.log`
  stream. **Off by default and additive** — when the flag is unset the code
  path is unchanged (verified: no request-log call, `includeRawChunks` keeps
  its prior value via an added `|| flags.llmVerbose` OR-clause that is `false`
  by default, and the new stream tap is a true `Effect.void` no-op per event).
  When on, it captures: the fully prepared **raw outgoing request** (messages,
  tool schemas, params, headers) once per turn before the native/ai-sdk runtime
  branch; every **raw streamed event** off the AI SDK's `fullStream` — including
  `tool-input-delta` (the raw JSON text the model emits for tool args, where
  qwen2.5-style malformed output shows up), the parsed `tool-call`, `tool-error`,
  and `error` events; and **raw provider chunks** (`includeRawChunks`) which are
  otherwise Copilot-only. New module `packages/opencode/src/session/llm/verbose.ts`
  appends one JSON object per line, is `R = never` (plain `fs/promises.appendFile`
  wrapped in `Effect.promise`, not the Effect `FileSystem` service, so it doesn't
  leak a requirement into `LLM.Service.stream`'s signature), and every write is
  wrapped in `Effect.ignore` so a logging failure can never fail an LLM turn.
  Covered by new tests: `packages/opencode/test/effect/runtime-flags.test.ts`
  (the flag defaults false and reads `1`/`true`/`0`), and
  `packages/opencode/test/session/llm.test.ts` (a real turn against the mock
  HTTP fixture server writes both a `"kind":"request"` and a `"kind":"event"`
  line for its session when verbose is on; a control turn with the default
  `llmVerbose: false` writes nothing for its session). **Untested: the live
  capture against a real qwen2.5/ollama** — this host has no ollama installed,
  so the actual malformed-tool-call-JSON content this feature is meant to
  surface has not been observed end-to-end; an operator with local ollama
  should run with `LMPLAYER_LLM_VERBOSE=1` and inspect `llm-verbose.log`.
- **TUI regression coverage: CLI registration + resize.** Two prior
  investigations are now locked in with tests instead of relying on manual
  verification: (1) `lmplayer tui` and `lmplayer attach` are confirmed
  reachable and launch the interactive UI — the default `lmplayer` command is
  the non-interactive prompt/run command (`[message..]`), by design, since the
  TUI was made explicit-opt-in rather than default. A new subprocess test
  (`test/cli/tui/registration.test.ts`) spawns the real CLI and asserts
  `--help`, `tui --help`, and `attach --help` all exit 0 with the expected
  command text. (2) The interactive TUI's resize path fully re-renders on
  both grow and shrink, and **session message content reflows (re-wraps) to
  the new width instead of being cut off or frozen at the old width** — two
  new headless tests (`packages/tui/test/resize.test.tsx`) drive the real app
  through `@opentui/core/testing`'s `createTestRenderer`: one resizes the
  centered home screen (80x24 → 120x40 → 50x16, asserting re-centering and
  frame bounds), and the other loads a real session with one long assistant
  message and resizes it (100x30 → 40x20 → 120x40), asserting the message
  text stays visible and its wrap width tracks each new terminal size (no
  truncation, no stale-width frame).

### Fixed

- **Interactive TUI: force a full repaint on terminal resize (no more cut-off
  that a resize won't fix).** The main `lmplayer tui` renders through
  `@opentui/core`'s default alternate-screen mode, whose resize path
  (`CliRenderer.processResize`) reallocates the native buffers and schedules only
  a _diff_ render against `currentRenderBuffer` — the renderer's model of what is
  physically on screen — but, unlike every other terminal-desync path in that
  renderer (`resume()`, capability re-detection, split-footer transitions), it
  never forces a full repaint. On a real terminal a resize can scroll or clear the
  physical screen out from under that model, so the diff skips cells it believes
  are unchanged and previously-drawn content stays truncated — and resizing again
  does not repaint it (the class of bug Claude Code/Ink avoid by full-repainting
  on resize). Because `@opentui@0.4.3` exposes no public force-full-repaint API
  (`forceFullRepaintRequested` is private), lmplayer now installs its own resize
  handler (`packages/tui/src/app.tsx`) that, on every `@opentui` `"resize"` event,
  clears `currentRenderBuffer` to an off-screen sentinel baseline
  (`REPAINT_INVALIDATION_COLOR`, `packages/tui/src/util/renderer.ts`) so every
  visible cell differs from the baseline and is repainted — regardless of theme
  background. Covered by a deterministic unit test (`test/repaint.test.tsx`) and a
  wiring test that drives the real app through `@opentui/core/testing` and asserts
  the sentinel clear fires on resize (`test/resize.test.tsx`).

### Changed

- **Interactive TUI: the session sidebar is now hidden by default.** The
  right-hand session panel (`Sidebar`, a fixed 42-column column showing
  context/cost, MCP/LSP, todos, and modified files) previously auto-showed on any
  terminal wider than 120 columns, stealing horizontal space from the
  conversation. Its default is now hidden (`routes/session/index.tsx`), giving a
  clean full-width conversation view; the existing toggle —
  `session.sidebar.toggle`, default `<leader> b` (Ctrl+X then b) — still shows and
  hides it and persists the choice. Nothing essential is lost: model, context, and
  cost remain in the prompt footer and bottom status line, and MCP/LSP remain in
  the footer and the `/status` dialog. Child/subagent sessions never show the
  sidebar (unchanged).

## [1.17.15] - 2026-07-07

### Fixed

- **`run`: exit nonzero when a non-interactive turn ends before a terminal
  state (no more false success).** A non-interactive `lmplayer run` consumes the
  session event stream until it observes a terminal `session.status: idle` (clean
  finish) or a `session.error` (failed turn). If the stream ended before either
  signal — e.g. the in-process server's `/event` subscription closes on instance
  disposal or a connection drop mid-turn — the command previously returned
  cleanly, producing exit 0 with empty output (and empty `--format json`) on a
  turn that never actually completed. `run` now tracks whether idle was actually
  observed and, when the stream ends first, performs a direct
  `client.session.status()` check: only a genuinely idle/absent session counts as
  a clean finish; a still-active session (or a status lookup that cannot be
  confirmed) exits nonzero and, in JSON mode, emits an error record. `--attach`
  still returns immediately and is unaffected. The decision is covered by a
  deterministic unit test (`resolveRunCompletion`). Root cause reported by lmctl
  (lmplayerdev seq30).

### Changed

- **Upstream refresh:** merged 18 upstream opencode commits (through
  `feat(data): redesign model peers`), synchronizing release versions to
  `1.17.15`. Highlights: compaction keeps relevant files, home-relative
  permission-path expansion, zai token-limit overflow classification, plugin
  agent config additions, and desktop/app/stats UI fixes. All lmplayer features
  were preserved (unioned) across the merge; no lmplayer source required manual
  conflict resolution.
