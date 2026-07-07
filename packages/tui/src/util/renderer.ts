import { RGBA, type CliRenderer } from "@opentui/core"

export function destroyRenderer(renderer: Pick<CliRenderer, "isDestroyed" | "setTerminalTitle" | "destroy">) {
  renderer.setTerminalTitle("")
  if (renderer.isDestroyed) return
  renderer.destroy()
}

// Off-screen sentinel used only as the diff baseline when forcing a full repaint.
// @opentui diffs the next frame against currentRenderBuffer; clearing that baseline
// to a color no real theme or content cell can equal guarantees every visible cell
// differs from it and is repainted (clearing to the default opaque black would leave
// blank cells unrepainted under an opaque-black theme). This buffer is never
// displayed — it is swapped out after the render.
export const REPAINT_INVALIDATION_COLOR = RGBA.fromInts(255, 0, 255, 253)

export function forceFullRepaint(renderer: Pick<CliRenderer, "currentRenderBuffer" | "requestRender">) {
  // @opentui's alternate-screen resize path (CliRenderer.processResize) reallocates
  // the native buffers and schedules only a diff render against currentRenderBuffer —
  // its model of what is physically on screen — but, unlike every other terminal
  // desync path (resume(), capability re-detection, split-footer transitions), it
  // never forces a full repaint. On a real terminal a resize can scroll or clear the
  // physical screen out from under that model, so the diff skips cells it believes are
  // unchanged and previously-drawn content stays truncated/stale ("cut-off that
  // resizing won't fix"). Clearing currentRenderBuffer to the sentinel baseline
  // invalidates the on-screen model regardless of theme, so the next render repaints
  // every visible cell.
  renderer.currentRenderBuffer.clear(REPAINT_INVALIDATION_COLOR)
  renderer.requestRender()
}
