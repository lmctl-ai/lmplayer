import { describe, expect } from "bun:test"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Cause, Exit } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../../src/agent/agent"
import { CurlTool, classify, dangerousArgv, validateArgv } from "../../../src/tool/linux/curl"
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

describe("tool.curl classify", () => {
  it.effect("classifies curl as network read", () =>
    Effect.sync(() => {
      expect(classify(["https://example.com"])).toEqual({ verb: "read", resource: "url", network: true })
    }),
  )

  it.effect("flags denied output/config/upload/file-url options", () =>
    Effect.sync(() => {
      expect(classify(["-o", "out", "https://example.com"]).dangerous).toBe(true)
      expect(classify(["file:///etc/passwd"]).dangerous).toBe(true)
      expect(classify(["-K", "config"]).dangerous).toBe(true)
      expect(classify(["-Tfile", "https://example.com"]).dangerous).toBe(true)
    }),
  )
})

describe("tool.curl deny-list", () => {
  const rejected = [
    ["-o", "out", "https://example.com"],
    ["--output=out", "https://example.com"],
    ["file:///etc/passwd"],
    ["-K", "config"],
    ["--config=config"],
    ["-T", "file", "https://example.com"],
    ["--upload-file=file", "https://example.com"],
  ]

  for (const args of rejected) {
    it.effect(`dangerousArgv detects curl ${args.join(" ")}`, () =>
      Effect.sync(() => {
        expect(dangerousArgv(args)).toBeDefined()
        expect(() => validateArgv(args)).toThrow("is not permitted (output path, file URL, config file, or upload)")
      }),
    )
  }
})

describe("tool.curl behavioral", () => {
  it.instance("rejects denied argv before ask/exec", () =>
    Effect.gen(function* () {
      const tool = yield* (yield* CurlTool).init()
      const rec = makeCtx()
      const exit = yield* tool.execute({ args: ["-o", "out", "https://example.com"] }, rec.ctx).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err instanceof Error ? err.message : String(err)).toContain(
          "is not permitted (output path, file URL, config file, or upload)",
        )
      }
      expect(rec.requests.length).toBe(0)
    }),
  )

  it.instance("runs curl --version and carries network read classification", () =>
    Effect.gen(function* () {
      if (Bun.which("curl") === null) return
      const tool = yield* (yield* CurlTool).init()
      const result = yield* tool.execute({ args: ["--version"] }, ctx)
      expect(result.metadata.exit).toBe(0)
      expect(result.output).toContain("curl")
      expect(result.metadata.classification).toEqual({ verb: "read", resource: "url", network: true })
    }),
  )
})
