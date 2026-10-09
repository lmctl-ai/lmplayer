import { describe, expect, test } from "bun:test"
import { joinRunMessage } from "../../src/cli/cmd/run"

describe("joinRunMessage", () => {
  test("a single argument is the whole message and is not quoted", () => {
    expect(joinRunMessage(["Reply with exactly: X"])).toBe("Reply with exactly: X")
    expect(joinRunMessage(['say "hi" now'])).toBe('say "hi" now')
  })
  test("several arguments keep their boundaries", () => {
    expect(joinRunMessage(["fix", "the bug"])).toBe('fix "the bug"')
    expect(joinRunMessage(["a", "b"])).toBe("a b")
  })
  test("no arguments give an empty message", () => {
    expect(joinRunMessage([])).toBe("")
  })
})
