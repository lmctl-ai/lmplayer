import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { resolveWorkdir, resolveWorkdirWithConfig } from "../../../src/tool/linux/exec"

describe("tool.linux.exec resolveWorkdir", () => {
  test("default rejects outside workspace root", () => {
    const workspace = "/tmp/workspace"
    expect(() => resolveWorkdir(workspace, "../outside")).toThrow("resolves outside the workspace root")
  })

  test("configured extra root allows external workdir", async () => {
    const workspace = "/tmp/workspace"
    const outside = "/tmp/allowed-root"
    const config = Layer.mock(Config.Service)({
      get: () => Effect.succeed({ tool_workdir: { extra_roots: [outside] } }),
    })
    const result = await Effect.runPromise(resolveWorkdirWithConfig(workspace, outside).pipe(Effect.provide(config)))
    expect(result.cwd).toBe(path.resolve(outside))
    expect(result.extraRoots).toEqual([outside])
  })

  test("traversal escape beyond all roots is rejected", () => {
    const workspace = "/tmp/workspace"
    const outside = "/tmp/allowed-root"
    expect(() => resolveWorkdir(workspace, "/tmp/allowed-root/../escape", { extraRoots: [outside] })).toThrow(
      "resolves outside the workspace root",
    )
  })
})
