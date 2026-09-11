import { afterEach, expect } from "bun:test"
import path from "path"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { LSP } from "../../src/lsp/lsp"
import { Format } from "../../src/format"
import { Git } from "../../src/git"
import { Instruction } from "../../src/session/instruction"
import { SessionID, MessageID } from "../../src/session/schema"
import { Truncate } from "../../src/tool/truncate"
import { LsTool } from "../../src/tool/linux/ls"
import { GlobTool } from "../../src/tool/glob"
import { ReadTool } from "../../src/tool/read"
import { WriteTool } from "../../src/tool/write"
import { Tool } from "../../src/tool/tool"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      Permission.node,
      EventV2Bridge.node,
      CrossSpawnSpawner.node,
      FSUtil.node,
      Ripgrep.node,
      LSP.node,
      Format.node,
      Git.node,
      Instruction.node,
      Truncate.node,
    ]),
  ),
)

afterEach(disposeAllInstances)

for (const restriction of [undefined, "external_directory", "read", "edit", "glob"] as const) {
  it.instance(
    `external filesystem tools honor ${restriction ?? "unrestricted defaults"}`,
    () =>
      Effect.gen(function* () {
        const agents = yield* Agent.Service
        const agent = yield* agents.get("build")
        const permission = yield* Permission.Service
        const outside = yield* tmpdirScoped()
        const file = path.join(outside, "probe.txt")
        yield* Effect.promise(() => Bun.write(file, "original"))
        const ctx: Tool.Context = {
          sessionID: SessionID.make("ses_fs_default"),
          messageID: MessageID.make("msg_fs_default"),
          callID: "fs-default",
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => Effect.void,
          ask: (request) =>
            permission
              .ask({ ...request, sessionID: SessionID.make("ses_fs_default"), ruleset: agent!.permission })
              .pipe(Effect.orDie),
        }
        const ls = yield* LsTool
        const glob = yield* GlobTool
        const read = yield* ReadTool
        const write = yield* WriteTool
        const checks: { permission: string; run: Effect.Effect<unknown> }[] = [
          { permission: "read", run: (yield* ls.init()).execute({ path: outside }, ctx) },
          { permission: "glob", run: (yield* glob.init()).execute({ path: outside, pattern: "*.txt" }, ctx) },
          { permission: "read", run: (yield* read.init()).execute({ filePath: file }, ctx) },
          { permission: "edit", run: (yield* write.init()).execute({ filePath: file, content: "updated" }, ctx) },
        ]
        for (const check of checks) {
          const result = yield* check.run.pipe(Effect.exit)
          const denied = restriction === "external_directory" || restriction === check.permission
          expect(Exit.isFailure(result)).toBe(denied)
          if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("DeniedError")
        }
        expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(
          restriction === "external_directory" || restriction === "edit" ? "original" : "updated",
        )
        expect(yield* permission.list()).toEqual([])
      }),
    { config: { permission: restriction ? { [restriction]: "deny" } : {}, lsp: false, formatter: false } },
  )
}
