import { expect, mock, spyOn, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { OptimizedBuffer } from "@opentui/core"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"
import { REPAINT_INVALIDATION_COLOR } from "../src/util/renderer"

// Regression coverage for the interactive TUI's resize path: growing or
// shrinking the terminal must fully re-render at the new dimensions (no
// stale/cut-off frame at the old width). See investigation notes: the main
// TUI's resize path is byte-identical to upstream opencode and
// `renderer.resize` reliably reallocates + re-lays-out on SIGWINCH; this
// test locks that behavior in against the real app via the headless
// @opentui/core testing harness (modeled on app-lifecycle.test.tsx).
test("fully re-renders the home screen on grow and shrink, with no cut-off", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  // No providers configured in the fixture fetch, so the home screen renders
  // the "Connect a provider" dialog — stable text present at any width.
  const calls = createFetch()
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  let task!: Promise<void>
  try {
    const { run } = await import("../src/app")
    task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start() {
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )
    task.catch(() => {})

    await ready
    for (let i = 0; i < 6; i++) await setup.renderOnce()

    expect(setup.renderer.width).toBe(80)
    expect(setup.renderer.height).toBe(24)
    const frameA = setup.captureCharFrame()
    expect(frameA).toContain("Connect a provider")
    const indentA = frameA.split("\n").find((line) => line.includes("Connect a provider"))!.indexOf("Connect a provider")

    // Grow: 80x24 -> 120x40.
    setup.resize(120, 40)
    for (let i = 0; i < 6; i++) await setup.renderOnce()

    expect(setup.renderer.width).toBe(120)
    expect(setup.renderer.height).toBe(40)
    expect(setup.renderer.root.width).toBe(120)
    expect(setup.renderer.root.height).toBe(40)
    const frameB = setup.captureCharFrame()
    const linesB = frameB.split("\n").filter((line, index, all) => index < all.length - 1 || line.length > 0)
    expect(linesB.length).toBe(40)
    expect(frameB).toContain("Connect a provider")
    const indentB = frameB.split("\n").find((line) => line.includes("Connect a provider"))!.indexOf("Connect a provider")
    // The home screen re-centers its content (alignItems="center") at the
    // new width, so the leading indentation before the dialog must grow —
    // this proves a real re-layout at 120 cols, not a stale 80-wide frame
    // padded/cut-off on the right.
    expect(indentB).toBeGreaterThan(indentA)

    // Shrink: 120x40 -> 50x16.
    setup.resize(50, 16)
    for (let i = 0; i < 6; i++) await setup.renderOnce()

    expect(setup.renderer.width).toBe(50)
    expect(setup.renderer.height).toBe(16)
    expect(setup.renderer.root.width).toBe(50)
    expect(setup.renderer.root.height).toBe(16)
    const frameC = setup.captureCharFrame()
    const linesC = frameC.split("\n").filter((line, index, all) => index < all.length - 1 || line.length > 0)
    expect(linesC.length).toBe(16)
    for (const line of linesC) expect(line.length).toBeLessThanOrEqual(50)
    expect(frameC).toContain("Connect a provider")
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
    await task
  }
})

// Regression coverage for the actual reported concern: does SESSION MESSAGE
// content reflow (re-wrap) on resize, or does it stay cut off at the old
// width? Unlike the home-screen test above (which only proves the centered
// dialog re-centers), this drives a real session with one long assistant
// message through the same `run()` entrypoint, `args: { continue: true }`
// auto-navigating into it (see app-lifecycle.test.tsx's second test), and
// asserts the message text re-wraps to each new terminal width rather than
// being lost or frozen at the original width.
test("session message content reflows (re-wraps) on resize, with no truncation", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))

  const sessionID = "ses_resize_reflow"
  const messageID = "msg_resize_reflow"
  const partID = "prt_resize_reflow"
  const marker = "RESIZE_MARKER_7f3a"
  // A single long line, well over both the wide (120) and narrow (40) test
  // widths, with a distinctive marker substring so presence/loss is easy to
  // assert regardless of exact wrap points.
  const longText =
    `${marker} ` +
    "the quick brown fox jumps over the lazy dog and keeps going and going and going across the whole terminal width and further still until it is unmistakably longer than any single row"

  const session = {
    id: sessionID,
    title: "resize reflow",
    slug: "resize-reflow",
    projectID: "proj_test",
    directory,
    version: "0.0.0-test",
    time: { created: 0, updated: 0 },
  }
  const assistantMessage = {
    id: messageID,
    sessionID,
    role: "assistant" as const,
    agent: "build",
    modelID: "test-model",
    providerID: "test",
    mode: "build",
    parentID: "msg_user",
    path: { cwd: directory, root: directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, completed: 2 },
  }
  const textPart = { id: partID, sessionID, messageID, type: "text" as const, text: longText }

  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/session") return json([session])
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) return json([{ info: assistantMessage, parts: [textPart] }])
    if (url.pathname === `/session/${sessionID}/todo`) return json([])
    if (url.pathname === `/session/${sessionID}/diff`) return json({})
    return undefined
  }, events)

  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  let task!: Promise<void>
  try {
    const { run } = await import("../src/app")
    task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: { continue: true },
        pluginHost: {
          async start() {
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )
    task.catch(() => {})

    await ready
    // Give sync + the `continue` auto-navigate effect enough render passes to
    // load the session list, navigate into the session, and hydrate messages.
    for (let i = 0; i < 20; i++) await setup.renderOnce()

    expect(setup.renderer.width).toBe(100)
    expect(setup.renderer.height).toBe(30)
    const frameWide = setup.captureCharFrame()
    expect(frameWide).toContain(marker)

    // Shrink: 100x30 -> 40x20. The message must still be visible, and every
    // captured line must fit within the new (narrower) width — proving the
    // content re-wrapped to 40 cols rather than being cut off from a frame
    // still laid out at the old width.
    setup.resize(40, 20)
    for (let i = 0; i < 10; i++) await setup.renderOnce()

    expect(setup.renderer.width).toBe(40)
    expect(setup.renderer.height).toBe(20)
    const frameNarrow = setup.captureCharFrame()
    expect(frameNarrow).toContain(marker)
    const linesNarrow = frameNarrow.split("\n").filter((line, index, all) => index < all.length - 1 || line.length > 0)
    for (const line of linesNarrow) expect(line.length).toBeLessThanOrEqual(40)

    // Grow back: 40x20 -> 120x40. The message must still be visible, and at
    // least one content line must now be wider than the narrow 40-col cap —
    // proving the layout re-flowed wider again rather than staying stuck at
    // the narrow wrap width (i.e. a real re-render, not a frozen frame).
    setup.resize(120, 40)
    for (let i = 0; i < 10; i++) await setup.renderOnce()

    expect(setup.renderer.width).toBe(120)
    expect(setup.renderer.height).toBe(40)
    const frameWideAgain = setup.captureCharFrame()
    expect(frameWideAgain).toContain(marker)
    const linesWideAgain = frameWideAgain
      .split("\n")
      .filter((line, index, all) => index < all.length - 1 || line.length > 0)
    expect(linesWideAgain.some((line) => line.trimEnd().length > 40)).toBe(true)
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
    await task
  }
})

test("forces a full repaint (clears the current buffer) on resize", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch()
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let task!: Promise<void>
  const clearSpy = spyOn(OptimizedBuffer.prototype, "clear")
  try {
    const { run } = await import("../src/app")
    task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start() {
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )
    task.catch(() => {})
    await ready
    for (let i = 0; i < 6; i++) await setup.renderOnce()
    clearSpy.mockClear()
    setup.resize(120, 40)
    const sentinelClears = clearSpy.mock.calls.filter((args) => args[0] === REPAINT_INVALIDATION_COLOR).length
    expect(sentinelClears).toBeGreaterThan(0)
  } finally {
    clearSpy.mockRestore()
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
    await task
  }
})
