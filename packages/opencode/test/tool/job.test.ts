import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionJobRuntime } from "@/session/job-runtime"
import { SessionJobStore } from "@/session/job-store"
import { MessageID, SessionID } from "@/session/schema"
import { Truncate } from "@/tool/truncate"
import { JobTool } from "@/tool/job"
import * as Tool from "@/tool/tool"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionJobRuntime.node,
      SessionJobStore.node,
      Database.node,
      EventV2Bridge.node,
      Agent.node,
      Truncate.node,
      CrossSpawnSpawner.node,
      FSUtil.node,
    ]),
    [[Database.node, Database.layerFromPath(":memory:")]],
  ),
)

import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const setupSession = Effect.fn("JobToolTest.setup")(function* () {
  const { db } = yield* Database.Service
  const suffix = crypto.randomUUID()
  const projectID = ProjectV2.ID.make(`project-${suffix}`)
  const sessionID = SessionID.make(`ses_${suffix}`)
  const tmpDir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "job-tool-")))
  yield* Effect.addFinalizer(() => Effect.promise(() => rm(tmpDir, { recursive: true, force: true })))
  const directory = AbsolutePath.make(tmpDir)
  yield* db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: directory, sandboxes: [], time_created: Date.now(), time_updated: Date.now() })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: projectID,
      slug: suffix,
      directory,
      title: "job tool test",
      version: "test",
      time_created: Date.now(),
      time_updated: Date.now(),
    })
    .run()
    .pipe(Effect.orDie)
  return { sessionID, directory }
})

const createMockCtx = (sessionID: SessionID) => {
  const asks: Array<{ permission: string; patterns: string[]; metadata: any }> = []
  const ctx: Tool.Context = {
    sessionID,
    messageID: MessageID.make("msg_test"),
    callID: "call_test",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (input) =>
      Effect.sync(() => {
        asks.push(input as any)
      }),
  }
  return { ctx, asks }
}

describe("tool.job", () => {
  it.instance("tool metadata matches schema", () =>
    Effect.gen(function* () {
      const info = yield* JobTool
      expect(info.id).toBe("job")
      const tool = yield* info.init()
      expect(tool.description).toContain("Manage session-scoped background shell jobs")
    }),
  )

  it.instance("list returns empty array when no jobs exist", () =>
    Effect.gen(function* () {
      const { sessionID } = yield* setupSession()
      const { ctx } = createMockCtx(sessionID)
      const info = yield* JobTool
      const tool = yield* info.init()

      const result = yield* tool.execute({ action: "list" }, ctx)
      expect(result.title).toBe("Background jobs")
      const parsed = JSON.parse(result.output)
      expect(Array.isArray(parsed)).toBe(true)
      expect(parsed.length).toBe(0)
    }),
  )

  it.instance("list and get return submitted background jobs", () =>
    Effect.gen(function* () {
      const { sessionID, directory } = yield* setupSession()
      const { ctx } = createMockCtx(sessionID)
      const runtime = yield* SessionJobRuntime.Service
      const info = yield* JobTool
      const tool = yield* info.init()

      const submitted = yield* runtime.submit({
        sessionID,
        assistantMessageID: MessageID.make("msg_parent"),
        toolCallID: "call_job1",
        command: "echo test-output",
        cwd: directory,
        shell: "/bin/sh",
        timeout: 5_000,
        env: process.env,
      })

      // Test list
      const listResult = yield* tool.execute({ action: "list" }, ctx)
      const listParsed = JSON.parse(listResult.output)
      expect(listParsed.length).toBe(1)
      expect(listParsed[0]!.id).toBe(submitted.job.id)
      expect(listParsed[0]!.sessionID).toBe(sessionID)

      // Test get
      const getResult = yield* tool.execute({ action: "get", jobID: submitted.job.id }, ctx)
      expect(getResult.title).toBe(submitted.job.id)
      const getParsed = JSON.parse(getResult.output)
      expect(getParsed.id).toBe(submitted.job.id)
      expect(getParsed.sessionID).toBe(sessionID)
    }),
  )

  it.instance("stop triggers permission ask and stops the job", () =>
    Effect.gen(function* () {
      const { sessionID, directory } = yield* setupSession()
      const { ctx, asks } = createMockCtx(sessionID)
      const runtime = yield* SessionJobRuntime.Service
      const store = yield* SessionJobStore.Service
      const info = yield* JobTool
      const tool = yield* info.init()

      const submitted = yield* runtime.submit({
        sessionID,
        assistantMessageID: MessageID.make("msg_parent"),
        toolCallID: "call_stop_job",
        command: "sleep 60",
        cwd: directory,
        shell: "/bin/sh",
        timeout: 60_000,
        env: process.env,
      })

      // Wait until the job is active (running or starting)
      yield* pollWithTimeout(
        store.get(sessionID, submitted.job.id).pipe(
          Effect.map((row) => (row.status === "running" || row.status === "starting" ? row : undefined)),
        ),
        "job did not reach running state",
      )

      const stopResult = yield* tool.execute({ action: "stop", jobID: submitted.job.id }, ctx)
      expect(stopResult.title).toBe(submitted.job.id)

      expect(asks.length).toBe(1)
      expect(asks[0]!.permission).toBe("job")
      expect(asks[0]!.patterns).toEqual([`stop:${submitted.job.id}`])
      expect(asks[0]!.metadata).toEqual({ jobID: submitted.job.id })

      const stopParsed = JSON.parse(stopResult.output)
      expect(stopParsed.status).toBe("cancelled")
      expect(stopParsed.errorCode).toBe("explicit_stop")

      const getResult = yield* tool.execute({ action: "get", jobID: submitted.job.id }, ctx)
      const getParsed = JSON.parse(getResult.output)
      expect(getParsed.status).toBe("cancelled")
      expect(getParsed.errorCode).toBe("explicit_stop")
    }),
  )

  it.instance("output reads captured job output with pagination", () =>
    Effect.gen(function* () {
      const { sessionID, directory } = yield* setupSession()
      const { ctx } = createMockCtx(sessionID)
      const runtime = yield* SessionJobRuntime.Service
      const store = yield* SessionJobStore.Service
      const info = yield* JobTool
      const tool = yield* info.init()

      const submitted = yield* runtime.submit({
        sessionID,
        assistantMessageID: MessageID.make("msg_parent"),
        toolCallID: "call_output_job",
        command: "printf 'hello world\n'",
        cwd: directory,
        shell: "/bin/sh",
        timeout: 5_000,
        env: process.env,
      })

      // Wait until output is flushed and job is completed
      yield* pollWithTimeout(
        store.get(sessionID, submitted.job.id).pipe(
          Effect.map((row) => (row.output_bytes > 0 && row.time_completed !== null ? row : undefined)),
        ),
        "job did not complete with output",
      )

      const outputResult = yield* tool.execute({ action: "output", jobID: submitted.job.id }, ctx)
      expect(outputResult.title).toBe(submitted.job.id)
      const parsed = JSON.parse(outputResult.output)
      expect(parsed.jobID).toBe(submitted.job.id)
      expect(parsed.untrustedOutput).toContain("hello world")
    }),
  )

  it.instance("fails when required jobID is missing", () =>
    Effect.gen(function* () {
      const { sessionID } = yield* setupSession()
      const { ctx } = createMockCtx(sessionID)
      const info = yield* JobTool
      const tool = yield* info.init()

      // get without jobID
      const getMissing = yield* tool.execute({ action: "get" }, ctx).pipe(Effect.exit)
      expect(getMissing._tag).toBe("Failure")

      // stop without jobID
      const stopMissing = yield* tool.execute({ action: "stop" }, ctx).pipe(Effect.exit)
      expect(stopMissing._tag).toBe("Failure")

      // output without jobID
      const outputMissing = yield* tool.execute({ action: "output" }, ctx).pipe(Effect.exit)
      expect(outputMissing._tag).toBe("Failure")
    }),
  )
})
