import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"
import { formatCronDetail, formatCronsTable, type CronInfo } from "@/cli/cmd/session"

describe("session crons formatting", () => {
  test("formatCronsTable: formats crons table with correct columns and headers", () => {
    const crons: CronInfo[] = [
      {
        id: "cron_1234567890",
        sessionID: "ses_abc" as any,
        cron: "0 12 * * *",
        prompt: "daily noon status check",
        recurring: true,
        createdAt: 1000,
        expiresAt: 1000 + 7 * 24 * 60 * 60 * 1000,
        lastFiredAt: 5000,
      },
      {
        id: "cron_0987654321",
        sessionID: "ses_abc" as any,
        cron: "*/5 * * * *",
        prompt: "short check",
        recurring: false,
        createdAt: 2000,
      },
    ]

    const output = formatCronsTable(crons)
    expect(output).toContain("Cron ID")
    expect(output).toContain("Schedule")
    expect(output).toContain("Recurring")
    expect(output).toContain("Last Fired")
    expect(output).toContain("Expires")
    expect(output).toContain("Prompt")
    expect(output).toContain("cron_1234567890")
    expect(output).toContain("0 12 * * *")
    expect(output).toContain("yes")
    expect(output).toContain("daily noon status check")
    expect(output).toContain("cron_0987654321")
    expect(output).toContain("*/5 * * * *")
    expect(output).toContain("no")
    expect(output).toContain("short check")
  })

  test("formatCronDetail: formats individual cron fields correctly", () => {
    const cron: CronInfo = {
      id: "cron_detail_123",
      sessionID: "ses_xyz" as any,
      cron: "30 9 * * 1-5",
      prompt: "standup reminder",
      recurring: true,
      createdAt: 1000,
      expiresAt: 20000,
      lastFiredAt: 15000,
    }

    const detail = formatCronDetail(cron)
    expect(detail).toContain("Cron ID: cron_detail_123")
    expect(detail).toContain("Session ID: ses_xyz")
    expect(detail).toContain("Schedule: 30 9 * * 1-5")
    expect(detail).toContain("Recurring: yes")
    expect(detail).toContain("Prompt: standup reminder")
    expect(detail).toContain("Created:")
    expect(detail).toContain("Expires:")
    expect(detail).toContain("Last fired:")
  })
})

describe("opencode session crons (CLI)", () => {
  cliIt.concurrent(
    "fails cleanly when targeting non-existent session or cron",
    ({ opencode }) =>
      Effect.gen(function* () {
        const notFound = "ses_nonexistent456"

        // Non-existent session
        const cronsRes = yield* opencode.spawn(["session", "crons", notFound])
        opencode.expectExit(cronsRes, 1)
        expect(cronsRes.stderr).toContain(`Session not found: ${notFound}`)

        const cronsJsonRes = yield* opencode.spawn(["session", "crons", notFound, "--json"])
        opencode.expectExit(cronsJsonRes, 1)
        expect(cronsJsonRes.stderr).toContain(`Session not found: ${notFound}`)
      }),
    60_000,
  )

  cliIt.concurrent(
    "inspects crons and metrics on an active session",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("hello from assistant")
        const runRes = yield* opencode.run("ping test", { format: "json" })
        opencode.expectExit(runRes, 0)
        const events = opencode.parseJsonEvents(runRes.stdout)
        const sessionID = events[0]?.sessionID as string
        expect(sessionID).toBeDefined()

        // 1. Check crons table output when empty
        const cronsRes = yield* opencode.spawn(["session", "crons", sessionID])
        opencode.expectExit(cronsRes, 0)
        expect(cronsRes.stdout).toContain(`No scheduled cron jobs found for session ${sessionID}`)

        // 2. Check crons --json output when empty
        const cronsJsonRes = yield* opencode.spawn(["session", "crons", sessionID, "--json"])
        opencode.expectExit(cronsJsonRes, 0)
        const cronsData = JSON.parse(cronsJsonRes.stdout)
        expect(Array.isArray(cronsData)).toBe(true)
        expect(cronsData.length).toBe(0)

        // 3. Missing cron inspection fails cleanly
        const cronMissingRes = yield* opencode.spawn(["session", "crons", sessionID, "--cron", "cron_missing"])
        opencode.expectExit(cronMissingRes, 1)
        expect(cronMissingRes.stderr).toContain("Cron not found: cron_missing")

        // 4. Missing cron deletion fails cleanly
        const cronDeleteMissingRes = yield* opencode.spawn(["session", "crons", sessionID, "--delete", "cron_missing"])
        opencode.expectExit(cronDeleteMissingRes, 1)
        expect(cronDeleteMissingRes.stderr).toContain("not found")

        // 5. Verify session metrics include crons block
        const metricsRes = yield* opencode.spawn(["session", "metrics", sessionID, "--json"])
        opencode.expectExit(metricsRes, 0)
        const metricsData = JSON.parse(metricsRes.stdout)
        expect(metricsData.schema).toBe("session-metrics/v1")
        expect(metricsData.crons).toBeDefined()
        expect(metricsData.crons).toEqual({
          total: 0,
          recurring: 0,
          one_shot: 0,
        })
      }),
    60_000,
  )
})
