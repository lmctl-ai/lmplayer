import { describe, expect } from "bun:test"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Cause, Exit } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../../src/agent/agent"
import { WgetTool, classify, dangerousArgv, validateArgv } from "../../../src/tool/linux/wget"
import { SessionID, MessageID } from "../../../src/session/schema"
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

describe("tool.wget classify", () => {
  it.effect("classifies wget as network read", () =>
    Effect.sync(() => {
      expect(classify(["https://example.com"])).toEqual({ verb: "read", resource: "url", network: true })
    }),
  )

  it.effect("flags denied output/input-file/file-url options", () =>
    Effect.sync(() => {
      expect(classify(["-O", "out", "https://example.com"]).dangerous).toBe(true)
      expect(classify(["--input-file=list"]).dangerous).toBe(true)
      expect(classify(["file:///etc/passwd"]).dangerous).toBe(true)
    }),
  )
})

describe("tool.wget deny-list", () => {
  const rejected = [
    ["-O", "out", "https://example.com"],
    ["-Oout", "https://example.com"],
    ["--output-document=out", "https://example.com"],
    ["-i", "urls.txt"],
    ["--input-file=urls.txt"],
    ["file:///etc/passwd"],
  ]

  for (const args of rejected) {
    it.effect(`dangerousArgv detects wget ${args.join(" ")}`, () =>
      Effect.sync(() => {
        expect(dangerousArgv(args)).toBeDefined()
        expect(() => validateArgv(args)).toThrow("is not permitted (output path, input file, or file URL)")
      }),
    )
  }
})

describe("tool.wget behavioral", () => {
  it.instance("rejects denied argv before ask/exec", () =>
    Effect.gen(function* () {
      const tool = yield* (yield* WgetTool).init()
      const rec = makeCtx()
      const exit = yield* tool.execute({ args: ["-O", "out", "https://example.com"] }, rec.ctx).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err instanceof Error ? err.message : String(err)).toContain(
          "is not permitted (output path, input file, or file URL)",
        )
      }
      expect(rec.requests.length).toBe(0)
    }),
  )

  it.instance("runs wget --version and carries network read classification", () =>
    Effect.gen(function* () {
      if (Bun.which("wget") === null) return
      const tool = yield* (yield* WgetTool).init()
      const result = yield* tool.execute({ args: ["--version"] }, ctx)
      expect(result.metadata.exit).toBe(0)
      expect(result.output).toContain("Wget")
      expect(result.metadata.classification).toEqual({ verb: "read", resource: "url", network: true })
    }),
  )
})
