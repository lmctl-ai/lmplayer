export const SYNTHETIC_RECOVERY_PROMPT =
  "[Synthetic recovery prompt — not written by the user] The previous assistant response ended without a following user turn, possibly because generation was interrupted. Continue it if needed; otherwise respond to the conversation as it now stands."

export function ensureUserTerminated<T extends { readonly role: string }>(
  messages: readonly T[],
  recovery: T,
): T[] {
  if (messages.at(-1)?.role !== "assistant") return [...messages]
  return [...messages, recovery]
}
