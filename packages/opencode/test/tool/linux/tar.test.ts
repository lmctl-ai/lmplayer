import { describe, expect } from "bun:test"
import path from "path"
import fs from "node:fs/promises"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Cause, Exit } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../../src/agent/agent"
import { TarTool, classify, dangerousArgv, validateArgv } from "../../../src/tool/linux/tar"
import { SessionID, MessageID } from "../../../src/session/schema"
import { TestInstance } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import type { Tool } from "@/tool/tool"

const toolLayer = LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node, FSUtil.node, Truncate.node, Agent.node]))

const it = testEffect(toolLayer)

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

function makeCtx() {
  const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  const recording: Tool.Context = {
    ...ctx,
    ask: (req) =>
      Effect.sync(() => {
        requests.push(req)
      }),
  }
  return { requests, ctx: recording }
}

describe("tool.tar classify", () => {
  it.effect("classifies archive creation as create", () =>
    Effect.sync(() => {
      expect(classify(["-cf", "archive.tar", "src"])).toEqual({
        verb: "create",
        resource: "archive",
        network: false,
      })
    }),
  )

  it.effect("classifies extraction as modify and listing as read", () =>
    Effect.sync(() => {
      expect(classify(["-xf", "archive.tar"])).toMatchObject({ verb: "modify", network: false })
      expect(classify(["-tf", "archive.tar"])).toMatchObject({ verb: "read", network: false })
    }),
  )

  it.effect("flags denied command vectors", () =>
    Effect.sync(() => {
      expect(classify(["-xf", "archive.tar", "--to-command", "sh"]).dangerous).toBe(true)
      expect(classify(["-I", "evil", "-cf", "archive.tar", "src"]).dangerous).toBe(true)
    }),
  )
})

describe("tool.tar deny-list", () => {
  it.effect("rejects command vectors, absolute paths, and traversal", () =>
    Effect.sync(() => {
      for (const args of [
        ["-xf", "archive.tar", "--to-command", "sh"],
        ["-I", "evil", "-cf", "archive.tar", "src"],
        ["-cf", "/tmp/archive.tar", "src"],
        ["-cf", "archive.tar", "../secret"],
      ]) {
        expect(dangerousArgv(args)).toBeDefined()
        expect(() => validateArgv(args)).toThrow(
          "is not permitted (absolute path, traversal, symlink, or command vector)",
        )
      }
    }),
  )

  it.instance("rejects symlink operands", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "target.txt"), "hello\n"))
      yield* Effect.promise(() => fs.symlink("target.txt", path.join(test.directory, "link.txt")))

      expect(dangerousArgv(["-cf", "archive.tar", "link.txt"], test.directory)).toBe("link.txt (symlink)")
      expect(() => validateArgv(["-cf", "archive.tar", "link.txt"], test.directory)).toThrow("symlink")
    }),
  )
})

describe("tool.tar behavioral", () => {
  it.instance("rejects denied argv before ask/exec", () =>
    Effect.gen(function* () {
      const info = yield* TarTool
      const tool = yield* info.init()
      const rec = makeCtx()
      const exit = yield* tool.execute({ args: ["-xf", "archive.tar", "--to-command", "sh"] }, rec.ctx).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err instanceof Error ? err.message : String(err)).toContain(
          "is not permitted (absolute path, traversal, symlink, or command vector)",
        )
      }
      expect(rec.requests.length).toBe(0)
    }),
  )

  it.instance("creates an archive and carries create classification", () =>
    Effect.gen(function* () {
      if (Bun.which("tar") === null) return
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "file.txt"), "hello\n"))

      const tool = yield* (yield* TarTool).init()
      const result = yield* tool.execute({ args: ["-cf", "archive.tar", "file.txt"] }, ctx)
      expect(result.metadata.exit).toBe(0)
      expect(result.metadata.classification).toEqual({ verb: "create", resource: "archive", network: false })
      expect(yield* Effect.promise(() => Bun.file(path.join(test.directory, "archive.tar")).exists())).toBe(true)
    }),
  )
})
