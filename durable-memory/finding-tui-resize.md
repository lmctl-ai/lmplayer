# Finding: TUI launchability + resize/cut-off investigation

Delivered `test:` commit `ae534e94c` (pushed to lmplayer dev). Coder=sonnet-5,
Reviewer1=gpt-5.5 (APPROVE-WITH-NITS). No functional source change — this task
verified behavior and locked it in with tests, because the reported bugs were
already-correct or non-reproducible in our code.

## Task A — TUI is NON-DEFAULT, not disabled
- Commit `144352880` moved the TUI from the yargs default `$0 [project]` to the
  explicit subcommand `tui [project]` (`packages/opencode/src/cli/cmd/tui.ts:72`)
  and added a non-interactive `DefaultCommand` `$0 [message..]` in
  `packages/opencode/src/index.ts` (registered at `index.ts:108` via
  `.command(TuiThreadCommand)`; default at `:109`).
- `lmplayer tui` and `lmplayer attach <url>` are registered, reachable, and DO
  launch the interactive UI. Both route non-`--mini` mode through
  `cli/tui/layer.ts` → `@opentui-ai/tui` `run()`. Build includes the TUI worker
  (`script/build.ts:188` entrypoint + `OPENCODE_WORKER_PATH`). No gating.
- Launch (dev, from `packages/opencode`, needs its bunfig solid preload):
  `bun run ./src/index.ts tui [project]` (or the installed `lmplayer tui`).
- `temporary.ts` is a dev-only 2nd yargs entry (`dev:temporary`) that registers
  only `TuiThreadCommand` as `tui` — not a production concern.
- Regression test: `packages/opencode/test/cli/tui/registration.test.ts`
  (`cliIt.live`; asserts `--help` / `tui --help` / `attach --help` reachable;
  default is the message/run command). NB: yargs writes `--help` to STDERR.

## Task B — main-TUI resize already re-renders correctly on SIGWINCH
- The resize path is BYTE-IDENTICAL to upstream opencode: `packages/tui/src/app.tsx`,
  mini `packages/opencode/src/cli/cmd/run/{runtime,runtime.lifecycle,stream.transport}.ts`,
  `cli/tui/layer.ts` all == `origin/dev`. Only `tui.ts` differs (the 3-line rename).
  So any resize behavior is inherited from upstream, not a lmplayer regression.
- Mechanism: root `<box width={dimensions().width} height={dimensions().height}>`
  (`app.tsx:1088`) where `dimensions = useTerminalDimensions()` (`app.tsx:369`).
  `@opentui/solid` `useTerminalDimensions` seeds a signal from `renderer.width/height`
  and subscribes to the renderer `"resize"` event. `@opentui/core` `sigwinchHandler`
  (registered only when `stdout === process.stdout`) → `handleResize` (100ms debounce)
  → `processResize` → `lib.resizeRenderer` + `emit("resize")` + `requestRender`.
- Verified full re-render on resize THREE ways (grow AND shrink):
  1. tmux (`resize-window` + `window-size manual`).
  2. raw pty: python `TIOCSWINSZ` triggers kernel SIGWINCH; app emitted ~10KB
     repaint addressing col 119 / row 40 at 120x40. (harness: `/tmp/lmplayer/ptyresize.py`)
  3. `@opentui/core/testing` `createTestRenderer` driving the REAL app.
- Gap (latent, not observed to bite): `processResize` does NOT set
  `forceFullRepaintRequested`; it relies on native `resizeRenderer` realloc for a
  full repaint. `@opentui/core@0.4.3` exposes NO public force-full-repaint API
  (checked renderer.d.ts / Renderable.d.ts; `markDirty` is protected; only
  `requestRender` (diff) + `intermediateRender` are public). So the operator's
  suggested "force full clear+redraw on resize" cannot be done in our code without
  reaching @opentui private state or patching the minified dist (judged fragile +
  redundant given native realloc already repaints).
- `--replay` / replayOnResize is MINI-only (`--mini`): split-footer + capture-stdout
  writes session history to REAL scrollback and re-writes it on resize via
  `resetForReplay` → `renderer.resetSplitFooterForReplay({clearSavedLines:true})`
  (`cli/cmd/run/runtime.lifecycle.ts:373`). Could NOT reproduce a cut-off there
  headlessly (model calls fail in sandbox; scrollback harness commit-timing friction).
- Regression test: `packages/tui/test/resize.test.tsx` — home grow/shrink +
  a session-content test (long assistant message re-wraps 100x30→40x20→120x40,
  marker stays visible, line-width bound tracks each size; fails if content were
  cut off or frozen at a stale width in either direction).

## Reusable: how to test the TUI headlessly
`createTestRenderer` (`@opentui/core/testing`) + `mock.module("@opentui/core", ...)`
to swap `createCliRenderer`, then run the real `run()` from `packages/tui/src/app`.
Exposes `resize(w,h)` (calls `processResize`), `captureCharFrame()`,
`getNativeStats().cellsUpdated`, `renderOnce()`. Pattern seed:
`packages/tui/test/app-lifecycle.test.tsx`. `args:{continue:true}` + a `/session`
list auto-navigates into a session (`app.tsx` continue effect). Serve
`/session/{id}`, `/session/{id}/message`, `/todo`, `/diff` in the `createFetch`
override to render message content. (`Failed to read KV state ... kv.json ENOENT`
is pre-existing harness noise.)
