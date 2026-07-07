import { expect, test } from "bun:test"
import type { CliRenderer } from "@opentui/core"
import { forceFullRepaint, REPAINT_INVALIDATION_COLOR } from "../src/util/renderer"

test("forceFullRepaint clears the current buffer with the sentinel baseline then requests a render", () => {
  const calls: string[] = []
  const clearArgs: unknown[] = []
  const renderer = {
    currentRenderBuffer: {
      clear: (bg?: unknown) => {
        calls.push("clear")
        clearArgs.push(bg)
      },
    },
    requestRender: () => calls.push("requestRender"),
  } as unknown as Pick<CliRenderer, "currentRenderBuffer" | "requestRender">
  forceFullRepaint(renderer)
  expect(calls).toEqual(["clear", "requestRender"])
  expect(clearArgs).toEqual([REPAINT_INVALIDATION_COLOR])
})
