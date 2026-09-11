import { describe, expect, test } from "bun:test"
import path from "path"
import { resolveWorkdir } from "../../../src/tool/linux/exec"

describe("tool.linux.exec resolveWorkdir", () => {
  test("default allows external absolute and relative workdirs", () => {
    expect(resolveWorkdir("/tmp/workspace", "../outside")).toBe("/tmp/outside")
    expect(resolveWorkdir("/tmp/workspace", "/tmp/outside")).toBe("/tmp/outside")
    expect(resolveWorkdir("/tmp/workspace")).toBe("/tmp/workspace")
  })

  test("configured extra root allows external workdir", () => {
    expect(resolveWorkdir("/tmp/workspace", "/tmp/allowed-root/nested", { extraRoots: ["/tmp/allowed-root"] })).toBe(
      path.resolve("/tmp/allowed-root/nested"),
    )
  })

  test("explicit empty roots restrict workdir to the workspace", () => {
    expect(resolveWorkdir("/tmp/workspace", "nested", { extraRoots: [] })).toBe("/tmp/workspace/nested")
    expect(() => resolveWorkdir("/tmp/workspace", "../outside", { extraRoots: [] })).toThrow(
      "resolves outside the workspace root",
    )
  })

  test("traversal escape beyond all roots is rejected", () => {
    const workspace = "/tmp/workspace"
    const outside = "/tmp/allowed-root"
    expect(() => resolveWorkdir(workspace, "/tmp/allowed-root/../escape", { extraRoots: [outside] })).toThrow(
      "resolves outside the workspace root",
    )
  })
})
