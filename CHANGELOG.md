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
- **Conditional chat-only mode for simple models (no tools offered).** Models
  flagged `tool_call:false` — which now includes every synthesized `ollama/*`
  model, and any other provider/model configured that way — are sent to the
  provider with **no tools at all** (empty/omitted), so a weak model
  (e.g. ollama qwen2.5) produces a plain **text** reply and can never emit the
  malformed tool-call JSON that breaks parsing. This is a *conditional*
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
  a *diff* render against `currentRenderBuffer` — the renderer's model of what is
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
