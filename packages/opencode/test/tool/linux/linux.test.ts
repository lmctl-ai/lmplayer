import { describe, expect } from "bun:test"
import path from "path"
import fs from "node:fs/promises"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../../src/agent/agent"
import { Git } from "@/git"
import { MkdirTool } from "../../../src/tool/linux/mkdir"
import { RmTool } from "../../../src/tool/linux/rm"
import { MvTool } from "../../../src/tool/linux/mv"
import { CpTool } from "../../../src/tool/linux/cp"
import { TouchTool } from "../../../src/tool/linux/touch"
import { WcTool } from "../../../src/tool/linux/wc"
import { SessionID, MessageID } from "../../../src/session/schema"
import { TestInstance, tmpdirScoped } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import type { Tool } from "@/tool/tool"

const toolLayer = LayerNode.compile(
  LayerNode.group([CrossSpawnSpawner.node, FSUtil.node, Truncate.node, Agent.node, Git.node]),
)

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

// Recording ctx: captures every ctx.ask request so tests can assert which
// permissions (edit/read/external_directory) a tool funnels through.
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

const exists = (p: string) =>
  Effect.promise(() =>
    fs.stat(p).then(
      () => true,
      () => false,
    ),
  )

describe("tool.linux", () => {
  it.instance("mkdir creates a directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const info = yield* MkdirTool
      const tool = yield* info.init()
      const dir = path.join(test.directory, "nested/deep")
      const result = yield* tool.execute({ path: dir }, ctx)
      expect(result.metadata.exit).toBe(0)
      expect(yield* exists(dir)).toBe(true)
    }),
  )

  it.instance("touch creates a file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const info = yield* TouchTool
      const tool = yield* info.init()
      const file = path.join(test.directory, "created.txt")
      const result = yield* tool.execute({ path: file }, ctx)
      expect(result.metadata.exit).toBe(0)
      expect(yield* exists(file)).toBe(true)
    }),
  )

  it.instance("cp copies a file (dest exists)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const src = path.join(test.directory, "src.txt")
      const dest = path.join(test.directory, "dest.txt")
      yield* Effect.promise(() => Bun.write(src, "hello\n"))
      const info = yield* CpTool
      const tool = yield* info.init()
      const result = yield* tool.execute({ source: src, dest }, ctx)
      expect(result.metadata.exit).toBe(0)
      expect(yield* exists(dest)).toBe(true)
      expect(yield* exists(src)).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(dest).text())).toBe("hello\n")
    }),
  )

  it.instance("mv renames (source gone, dest present)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const src = path.join(test.directory, "old.txt")
      const dest = path.join(test.directory, "new.txt")
      yield* Effect.promise(() => Bun.write(src, "data\n"))
      const info = yield* MvTool
      const tool = yield* info.init()
      const result = yield* tool.execute({ source: src, dest }, ctx)
      expect(result.metadata.exit).toBe(0)
      expect(yield* exists(src)).toBe(false)
      expect(yield* exists(dest)).toBe(true)
    }),
  )

  it.instance("rm deletes recursively", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "tree")
      const file = path.join(dir, "child.txt")
      yield* Effect.promise(() => Bun.write(file, "x\n"))
      const info = yield* RmTool
      const tool = yield* info.init()
      const result = yield* tool.execute({ paths: [dir], recursive: true }, ctx)
      expect(result.metadata.exit).toBe(0)
      expect(yield* exists(dir)).toBe(false)
    }),
  )

  it.instance("rm resolves relative paths against the project directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "rel.txt")
      yield* Effect.promise(() => Bun.write(file, "y\n"))
      const info = yield* RmTool
      const tool = yield* info.init()
      const result = yield* tool.execute({ paths: ["rel.txt"] }, ctx)
      expect(result.metadata.exit).toBe(0)
      expect(yield* exists(file)).toBe(false)
    }),
  )

  it.instance("wc counts file lines and words", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "count.txt")
      yield* Effect.promise(() => Bun.write(file, "hello world\nsecond line\n"))
      const tool = yield* (yield* WcTool).init()
      const result = yield* tool.execute({ paths: [file], lines: true, words: true }, ctx)
      expect(result.metadata.exit).toBe(0)
      expect(result.output.trim().split(/\s+/)).toEqual(["2", "4", file])
    }),
  )

  // --- `--` flag-injection regression: a path whose NAME starts with `-` must
  // be treated as a PATH operand, never misparsed as an option. `path.resolve`
  // absolutizes the operand, and the tools insert a `--` option terminator before
  // the first path — assert both the observable behavior AND that argv carries the
  // `--` immediately before the first path operand (this argv assertion fails if
  // the `--` guard is removed).
  describe("-- flag-injection guard", () => {
    // The `--` must appear and be followed only by path operands (no more flags).
    const assertDashGuard = (args: string[] | undefined, firstPath: string) => {
      expect(args).toBeDefined()
      const idx = args!.indexOf("--")
      expect(idx).toBeGreaterThanOrEqual(0)
      // everything after `--` is a positional path, and the first one is our path
      expect(args!.slice(idx + 1)).toContain(firstPath)
      // no option-looking token appears after `--`
      for (const a of args!.slice(idx + 1)) expect(a.startsWith("-") && a.length > 1 && !a.startsWith("/")).toBe(false)
    }

    it.instance("touch treats a leading-dash name as a path", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const file = path.join(test.directory, "-weird")
        const tool = yield* (yield* TouchTool).init()
        const result = yield* tool.execute({ path: file }, ctx)
        expect(result.metadata.exit).toBe(0)
        expect(yield* exists(file)).toBe(true)
        assertDashGuard(result.metadata.args as string[], file)
      }),
    )

    it.instance("mkdir treats a leading-dash name as a path", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const dir = path.join(test.directory, "-rf")
        const tool = yield* (yield* MkdirTool).init()
        const result = yield* tool.execute({ path: dir }, ctx)
        expect(result.metadata.exit).toBe(0)
        expect(yield* exists(dir)).toBe(true)
        assertDashGuard(result.metadata.args as string[], dir)
      }),
    )

    it.instance("cp treats leading-dash names as paths", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const src = path.join(test.directory, "-src")
        const dest = path.join(test.directory, "-dst")
        yield* Effect.promise(() => Bun.write(src, "z\n"))
        const tool = yield* (yield* CpTool).init()
        const result = yield* tool.execute({ source: src, dest }, ctx)
        expect(result.metadata.exit).toBe(0)
        expect(yield* exists(dest)).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(dest).text())).toBe("z\n")
        assertDashGuard(result.metadata.args as string[], src)
      }),
    )

    it.instance("mv treats leading-dash names as paths", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const src = path.join(test.directory, "-from")
        const dest = path.join(test.directory, "-to")
        yield* Effect.promise(() => Bun.write(src, "w\n"))
        const tool = yield* (yield* MvTool).init()
        const result = yield* tool.execute({ source: src, dest }, ctx)
        expect(result.metadata.exit).toBe(0)
        expect(yield* exists(src)).toBe(false)
        expect(yield* exists(dest)).toBe(true)
        assertDashGuard(result.metadata.args as string[], src)
      }),
    )

    it.instance("rm treats a leading-dash name as a path", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const file = path.join(test.directory, "-rf")
        yield* Effect.promise(() => Bun.write(file, "q\n"))
        const tool = yield* (yield* RmTool).init()
        const result = yield* tool.execute({ paths: [file] }, ctx)
        expect(result.metadata.exit).toBe(0)
        expect(yield* exists(file)).toBe(false)
        assertDashGuard(result.metadata.args as string[], file)
      }),
    )

    it.instance("wc treats a leading-dash name as a path", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const file = path.join(test.directory, "-count")
        yield* Effect.promise(() => Bun.write(file, "one two\n"))
        const tool = yield* (yield* WcTool).init()
        const result = yield* tool.execute({ paths: [file], words: true }, ctx)
        expect(result.metadata.exit).toBe(0)
        expect(result.output.trim().split(/\s+/)).toEqual(["2", file])
        assertDashGuard(result.metadata.args as string[], file)
      }),
    )
  })

  // --- external-directory gating: a target OUTSIDE the worktree must funnel
  // through the dedicated external_directory permission before the tool acts.
  describe("external-directory gating", () => {
    const externalOf = (reqs: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">>) =>
      reqs.filter((r) => r.permission === "external_directory")

    it.instance("touch gates an external path", () =>
      Effect.gen(function* () {
        const outside = yield* tmpdirScoped()
        const { requests, ctx: rec } = makeCtx()
        const file = path.join(outside, "ext.txt")
        const tool = yield* (yield* TouchTool).init()
        yield* tool.execute({ path: file }, rec)
        expect(externalOf(requests).length).toBeGreaterThan(0)
      }),
    )

    it.instance("mkdir gates an external path", () =>
      Effect.gen(function* () {
        const outside = yield* tmpdirScoped()
        const { requests, ctx: rec } = makeCtx()
        const dir = path.join(outside, "extdir")
        const tool = yield* (yield* MkdirTool).init()
        yield* tool.execute({ path: dir }, rec)
        expect(externalOf(requests).length).toBeGreaterThan(0)
      }),
    )

    it.instance("rm gates an external path", () =>
      Effect.gen(function* () {
        const outside = yield* tmpdirScoped()
        const { requests, ctx: rec } = makeCtx()
        const file = path.join(outside, "ext.txt")
        yield* Effect.promise(() => Bun.write(file, "e\n"))
        const tool = yield* (yield* RmTool).init()
        yield* tool.execute({ paths: [file] }, rec)
        expect(externalOf(requests).length).toBeGreaterThan(0)
      }),
    )

    it.instance("mv gates both external source and dest", () =>
      Effect.gen(function* () {
        const outside = yield* tmpdirScoped()
        const { requests, ctx: rec } = makeCtx()
        const src = path.join(outside, "a.txt")
        const dest = path.join(outside, "b.txt")
        yield* Effect.promise(() => Bun.write(src, "m\n"))
        const tool = yield* (yield* MvTool).init()
        yield* tool.execute({ source: src, dest }, rec)
        // one external ask for source, one for dest
        expect(externalOf(requests).length).toBe(2)
      }),
    )

    it.instance("cp gates the external SOURCE with a read ask (+ external)", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const outside = yield* tmpdirScoped()
        const { requests, ctx: rec } = makeCtx()
        // Source lives OUTSIDE the worktree; dest inside. This is the arbitrary
        // host-file-exfiltration case the source gate closes.
        const src = path.join(outside, "secret.txt")
        const dest = path.join(test.directory, "copied.txt")
        yield* Effect.promise(() => Bun.write(src, "secret\n"))
        const tool = yield* (yield* CpTool).init()
        yield* tool.execute({ source: src, dest }, rec)
        // external gate fired for the source, and the source is asked as `read`.
        expect(externalOf(requests).length).toBeGreaterThan(0)
        const readReq = requests.find((r) => r.permission === "read")
        expect(readReq).toBeDefined()
        expect(requests.find((r) => r.permission === "edit")).toBeDefined()
      }),
    )

    it.instance("cp gates an external DEST", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const outside = yield* tmpdirScoped()
        const { requests, ctx: rec } = makeCtx()
        const src = path.join(test.directory, "in.txt")
        const dest = path.join(outside, "out.txt")
        yield* Effect.promise(() => Bun.write(src, "d\n"))
        const tool = yield* (yield* CpTool).init()
        yield* tool.execute({ source: src, dest }, rec)
        expect(externalOf(requests).length).toBeGreaterThan(0)
      }),
    )
  })
})
