import { expect, test } from "bun:test"
import { Message } from "@opencode-ai/llm"
import {
  ensureUserTerminated,
  SYNTHETIC_RECOVERY_PROMPT,
} from "@opencode-ai/core/session/runner/ensure-user-terminated"

const recovery = Message.user(SYNTHETIC_RECOVERY_PROMPT)

test("leaves empty and user-terminated message arrays unchanged", () => {
  expect(ensureUserTerminated([], recovery)).toEqual([])
  expect(ensureUserTerminated([Message.user("hello")], recovery)).toEqual([Message.user("hello")])
})

test("preserves a trailing assistant and appends synthetic user recovery input", () => {
  const assistant = Message.assistant("partial response")
  expect(ensureUserTerminated([assistant], recovery)).toEqual([assistant, recovery])
})
