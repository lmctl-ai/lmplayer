// Custom provider fetches may await authentication or ignore cancellation.
// Bound the caller's wait even when the underlying promise does not cooperate.
export async function fetchWithAbort<T>(run: () => Promise<T>, signal?: AbortSignal | null): Promise<T> {
  signal?.throwIfAborted()
  if (!signal) return run()
  let abort = () => {}
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
  })
  try {
    return await Promise.race([run(), cancelled])
  } finally {
    signal.removeEventListener("abort", abort)
  }
}
