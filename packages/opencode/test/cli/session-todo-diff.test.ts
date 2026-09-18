import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"
import {
  formatSessionTodos,
  formatSessionDiffStat,
  formatSessionDiff,
  type SessionTodoItem,
  type SessionFileDiff,
} from "@/cli/cmd/session"

describe("session todo formatting", () => {
  test("formatSessionTodos: formats empty todo list", () => {
    const output = formatSessionTodos("ses_123", [])
    expect(output).toBe("No todos found for session ses_123")
  })

  test("formatSessionTodos: formats populated todo list with statuses and priorities", () => {
    const todos: SessionTodoItem[] = [
      {
        id: "todo_1",
        content: "Design new feature",
        status: "completed",
        priority: "high",
      },
      {
        id: "todo_2",
        content: "Implement core algorithm",
        status: "in_progress",
        priority: "high",
      },
      {
        id: "todo_3",
        content: "Add legacy migration",
        status: "cancelled",
        priority: "low",
      },
      {
        id: "todo_4",
        content: "Write unit test suite",
        status: "pending",
        priority: "medium",
      },
    ]

    const output = formatSessionTodos("ses_test", todos)
    expect(output).toContain("Todos for session ses_test (1/4 completed):")
    expect(output).toContain("[x] [high] Design new feature")
    expect(output).toContain("[>] [high] Implement core algorithm")
    expect(output).toContain("[-] [low] Add legacy migration")
    expect(output).toContain("[ ] [medium] Write unit test suite")
  })
})

describe("session diff formatting", () => {
  test("formatSessionDiffStat: formats empty diffs", () => {
    const output = formatSessionDiffStat("ses_123", [])
    expect(output).toBe("No diffs found for session ses_123")
  })

  test("formatSessionDiffStat: formats diffstat summary and totals", () => {
    const diffs: SessionFileDiff[] = [
      {
        file: "src/index.ts",
        additions: 12,
        deletions: 3,
        status: "modified",
      },
      {
        file: "src/util.ts",
        additions: 45,
        deletions: 0,
        status: "added",
      },
      {
        file: "src/legacy.ts",
        additions: 0,
        deletions: 20,
        status: "deleted",
      },
    ]

    const output = formatSessionDiffStat("ses_diff_test", diffs)
    expect(output).toContain("Diffstat for session ses_diff_test:")
    expect(output).toContain("src/index.ts | +12 -3")
    expect(output).toContain("src/util.ts | +45 -0")
    expect(output).toContain("src/legacy.ts | +0 -20")
    expect(output).toContain("3 file(s) changed, 57 insertions(+), 23 deletions(-)")
  })

  test("formatSessionDiff: formats full git diff patches", () => {
    const diffs: SessionFileDiff[] = [
      {
        file: "src/sample.ts",
        patch: "@@ -1,3 +1,4 @@\n+const x = 1;\n const y = 2;",
        additions: 1,
        deletions: 0,
        status: "modified",
      },
    ]

    const output = formatSessionDiff("ses_patch_test", diffs)
    expect(output).toContain("diff --git a/src/sample.ts b/src/sample.ts (+1 -0)")
    expect(output).toContain("+const x = 1;")
  })
})

describe("opencode session todo, diff, and export CLI commands", () => {
  cliIt.concurrent(
    "fails cleanly when targeting a non-existent session",
    ({ opencode }) =>
      Effect.gen(function* () {
        const notFound = "ses_nonexistent_xyz"

        const todoRes = yield* opencode.spawn(["session", "todo", notFound])
        opencode.expectExit(todoRes, 1)
        expect(todoRes.stderr).toContain(`Session not found: ${notFound}`)

        const diffRes = yield* opencode.spawn(["session", "diff", notFound])
        opencode.expectExit(diffRes, 1)
        expect(diffRes.stderr).toContain(`Session not found: ${notFound}`)

        const exportRes = yield* opencode.spawn(["session", "export", notFound])
        opencode.expectExit(exportRes, 1)
        expect(exportRes.stderr).toContain(`Session not found: ${notFound}`)
      }),
    60_000,
  )

  cliIt.concurrent(
    "executes session todo, diff, and export against a live session",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("session task executed")
        const runRes = yield* opencode.run("do something", { format: "json" })
        opencode.expectExit(runRes, 0)
        const events = opencode.parseJsonEvents(runRes.stdout)
        const sessionID = events[0]?.sessionID as string
        expect(sessionID).toBeDefined()

        // 1. session todo (empty list on fresh session)
        const todoRes = yield* opencode.spawn(["session", "todo", sessionID])
        opencode.expectExit(todoRes, 0)
        expect(todoRes.stdout).toContain(`No todos found for session ${sessionID}`)

        // 2. session todo with --json
        const todoJsonRes = yield* opencode.spawn(["session", "todo", sessionID, "--json"])
        opencode.expectExit(todoJsonRes, 0)
        const todos = JSON.parse(todoJsonRes.stdout)
        expect(Array.isArray(todos)).toBe(true)

        // 3. session diff (empty or diff array)
        const diffJsonRes = yield* opencode.spawn(["session", "diff", sessionID, "--json"])
        opencode.expectExit(diffJsonRes, 0)
        const diffs = JSON.parse(diffJsonRes.stdout)
        expect(Array.isArray(diffs)).toBe(true)

        // 4. session diff --stat
        const diffStatRes = yield* opencode.spawn(["session", "diff", sessionID, "--stat"])
        opencode.expectExit(diffStatRes, 0)

        // 5. session export
        const exportRes = yield* opencode.spawn(["session", "export", sessionID])
        opencode.expectExit(exportRes, 0)
        const exported = JSON.parse(exportRes.stdout)
        expect(exported.info).toBeDefined()
        expect(exported.info.id).toBe(sessionID)
        expect(Array.isArray(exported.messages)).toBe(true)
      }),
    60_000,
  )
})
