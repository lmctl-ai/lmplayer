import { describe, expect, test } from "bun:test"
import { allTargets, targetForSuffix, targetName, targetSuffix } from "../../script/build-target"

describe("release build targets", () => {
  test("exposes the complete, stable target matrix", () => {
    expect(allTargets).toHaveLength(12)
    expect(new Set(allTargets.map(targetSuffix)).size).toBe(12)
    expect(allTargets.map(targetSuffix)).toEqual([
      "linux-arm64",
      "linux-x64",
      "linux-x64-baseline",
      "linux-arm64-musl",
      "linux-x64-musl",
      "linux-x64-baseline-musl",
      "darwin-arm64",
      "darwin-x64",
      "darwin-x64-baseline",
      "windows-arm64",
      "windows-x64",
      "windows-x64-baseline",
    ])
  })

  test("round trips canonical target suffixes and rejects aliases", () => {
    for (const target of allTargets) expect(targetForSuffix(targetSuffix(target))).toEqual(target)
    expect(targetForSuffix("win32-x64")).toBeUndefined()
    expect(targetForSuffix("linux-x64-baseline-musl-extra")).toBeUndefined()
  })

  test("builds package names without loading the build script", () => {
    expect(targetName(allTargets[5])).toBe("lmplayer-linux-x64-baseline-musl")
    expect(targetName(allTargets[1], "opencode")).toBe("opencode-linux-x64")
  })
})
