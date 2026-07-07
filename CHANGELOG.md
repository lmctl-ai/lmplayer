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
