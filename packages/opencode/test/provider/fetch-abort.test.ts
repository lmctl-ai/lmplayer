import { expect, test } from "bun:test"
import { fetchWithAbort } from "../../src/provider/fetch-abort"

test("aborts a custom fetch that ignores its signal", async () => {
  const controller = new AbortController()
  const reason = new Error("Provider headers idle 50ms")
  const pending = fetchWithAbort(() => new Promise<never>(() => {}), controller.signal)
  controller.abort(reason)
  await expect(pending).rejects.toBe(reason)
})

test("does not start a fetch after cancellation", async () => {
  const reason = new Error("cancelled")
  let started = false
  await expect(
    fetchWithAbort(async () => {
      started = true
      return 1
    }, AbortSignal.abort(reason)),
  ).rejects.toBe(reason)
  expect(started).toBe(false)
})

test("preserves normal results and failures", async () => {
  expect(await fetchWithAbort(async () => 42, new AbortController().signal)).toBe(42)
  const reason = new Error("network failure")
  await expect(
    fetchWithAbort(async () => {
      throw reason
    }, new AbortController().signal),
  ).rejects.toBe(reason)
})
