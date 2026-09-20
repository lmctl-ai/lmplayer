import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import fs from "fs/promises"
import { cliIt } from "../lib/cli-process"
import { formatJobDetail, formatJobsTable, type JobInfo } from "@/cli/cmd/session"

describe("session jobs formatting", () => {
  test("formatJobsTable: formats jobs table with correct columns and headers", () => {
    const jobs: JobInfo[] = [
      {
        id: "job_1234567890",
        sessionID: "ses_abc",
        status: "completed",
        exitCode: 0,
        outputBytes: 2048,
        outputTruncated: false,
        outputExpired: false,
        time: {
          created: 1000,
          started: 1000,
          completed: 5000,
          updated: 5000,
        },
      },
      {
        id: "job_0987654321",
        sessionID: "ses_abc",
        status: "running",
        outputBytes: 500,
        outputTruncated: false,
        outputExpired: false,
        time: {
          created: 2000,
          started: 2000,
          updated: 3000,
        },
      },
    ]

    const output = formatJobsTable(jobs)
    expect(output).toContain("Job ID")
    expect(output).toContain("Status")
    expect(output).toContain("Exit")
    expect(output).toContain("Output")
    expect(output).toContain("Duration")
    expect(output).toContain("job_1234567890")
    expect(output).toContain("completed")
    expect(output).toContain("2.0 KB")
    expect(output).toContain("4s")
    expect(output).toContain("job_0987654321")
    expect(output).toContain("running")
    expect(output).toContain("500 B")
  })

  test("formatJobDetail: formats individual job fields correctly", () => {
    const job: JobInfo = {
      id: "job_detail_123",
      sessionID: "ses_xyz",
      status: "failed",
      exitCode: 1,
      errorCode: "nonzero_exit",
      signal: "SIGTERM",
      timeout: 30000,
      outputBytes: 1536,
      outputTruncated: false,
      outputExpired: false,
      time: {
        created: 1000,
        started: 1500,
        completed: 6500,
        updated: 6500,
      },
    }

    const detail = formatJobDetail(job)
    expect(detail).toContain("Job ID: job_detail_123")
    expect(detail).toContain("Session ID: ses_xyz")
    expect(detail).toContain("Status: failed")
    expect(detail).toContain("Output size: 1.5 KB (1536 bytes)")
    expect(detail).toContain("Exit code: 1")
    expect(detail).toContain("Error code: nonzero_exit")
    expect(detail).toContain("Signal: SIGTERM")
    expect(detail).toContain("Timeout: 30000ms")
    expect(detail).toContain("Created:")
    expect(detail).toContain("Started:")
    expect(detail).toContain("Completed:")
  })
})

describe("opencode session jobs (CLI)", () => {
  cliIt.concurrent(
    "fails cleanly when targeting non-existent session or job",
    ({ opencode }) =>
      Effect.gen(function* () {
        const notFound = "ses_nonexistent456"

        // Non-existent session
        const jobsRes = yield* opencode.spawn(["session", "jobs", notFound])
        opencode.expectExit(jobsRes, 1)
        expect(jobsRes.stderr).toContain(`Session not found: ${notFound}`)

        const jobsJsonRes = yield* opencode.spawn(["session", "jobs", notFound, "--json"])
        opencode.expectExit(jobsJsonRes, 1)
        expect(jobsJsonRes.stderr).toContain(`Session not found: ${notFound}`)
      }),
    60_000,
  )

  cliIt.concurrent(
    "inspects jobs and metrics on an active session",
    ({ llm, home, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("hello from assistant")
        const runRes = yield* opencode.run("ping test", { format: "json" })
        opencode.expectExit(runRes, 0)
        const events = opencode.parseJsonEvents(runRes.stdout)
        const sessionID = events[0]?.sessionID as string
        expect(sessionID).toBeDefined()

        // 1. Check jobs table output when empty
        const jobsRes = yield* opencode.spawn(["session", "jobs", sessionID])
        opencode.expectExit(jobsRes, 0)
        expect(jobsRes.stdout).toContain(`No background jobs found for session ${sessionID}`)

        // 2. Check jobs --json output when empty
        const jobsJsonRes = yield* opencode.spawn(["session", "jobs", sessionID, "--json"])
        opencode.expectExit(jobsJsonRes, 0)
        const jobsData = JSON.parse(jobsJsonRes.stdout)
        expect(Array.isArray(jobsData)).toBe(true)
        expect(jobsData.length).toBe(0)

        // 2b. Check jobs --file output when empty (text and JSON)
        const jobsOutFile = path.join(home, "jobs.txt")
        const jobsOutRes = yield* opencode.spawn(["session", "jobs", sessionID, "--file", jobsOutFile])
        opencode.expectExit(jobsOutRes, 0)
        expect(jobsOutRes.stderr).toContain(`Wrote jobs to ${jobsOutFile}`)
        const jobsFileContent = yield* Effect.promise(() => fs.readFile(jobsOutFile, "utf-8"))
        expect(jobsFileContent).toContain(`No background jobs found for session ${sessionID}`)

        const jobsJsonFile = path.join(home, "jobs.json")
        const jobsJsonOutRes = yield* opencode.spawn(["session", "jobs", sessionID, "--json", "--file", jobsJsonFile])
        opencode.expectExit(jobsJsonOutRes, 0)
        expect(jobsJsonOutRes.stderr).toContain(`Wrote jobs to ${jobsJsonFile}`)
        const jobsJsonParsed = JSON.parse(yield* Effect.promise(() => fs.readFile(jobsJsonFile, "utf-8")))
        expect(Array.isArray(jobsJsonParsed)).toBe(true)
        expect(jobsJsonParsed.length).toBe(0)

        // 3. Check status filtering when empty
        const jobsStatusRes = yield* opencode.spawn(["session", "jobs", sessionID, "--status", "running"])
        opencode.expectExit(jobsStatusRes, 0)
        expect(jobsStatusRes.stdout).toContain(
          `No background jobs found with status "running" for session ${sessionID}`,
        )

        // 4. Missing job inspection fails cleanly
        const jobMissingRes = yield* opencode.spawn(["session", "jobs", sessionID, "--job", "job_missing"])
        opencode.expectExit(jobMissingRes, 1)
        expect(jobMissingRes.stderr).toContain("not found")

        // 5. Missing job output fails cleanly
        const jobOutputMissingRes = yield* opencode.spawn(["session", "jobs", sessionID, "--output", "job_missing"])
        opencode.expectExit(jobOutputMissingRes, 1)
        expect(jobOutputMissingRes.stderr).toContain("not found")

        // 6. Verify session metrics include jobs block
        const metricsRes = yield* opencode.spawn(["session", "metrics", sessionID, "--json"])
        opencode.expectExit(metricsRes, 0)
        const metricsData = JSON.parse(metricsRes.stdout)
        expect(metricsData.schema).toBe("session-metrics/v1")
        expect(metricsData.jobs).toBeDefined()
        expect(metricsData.jobs).toEqual({
          total: 0,
          active: 0,
          completed: 0,
          failed: 0,
        })
      }),
    60_000,
  )
})
