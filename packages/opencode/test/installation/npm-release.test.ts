import { describe, expect, test } from "bun:test"
import { buildMatrix, nextVersion } from "../../../../script/lmplayer-release"
import { allTargets, targetSuffix } from "../../script/build-target"

describe("lmplayer release planning", () => {
  test("allocates beyond any already-published platform package", () => {
    expect(nextVersion("1.18.25", [])).toBe("1.18.25")
    expect(nextVersion("1.18.25", ["1.18.25", "1.18.26", "1.18.27-beta.1"])).toBe("1.18.27")
    expect(nextVersion("1.19.0", ["1.18.99"])).toBe("1.19.0")
    expect(() => nextVersion("invalid", [])).toThrow()
  })
  test("covers every declared target on a matching native runner", () => {
    const matrix = buildMatrix()
    expect(matrix.map((item) => item.target)).toEqual(allTargets.map(targetSuffix))
    expect(new Set(matrix.map((item) => item.target)).size).toBe(12)
    expect(matrix.find((item) => item.target === "linux-arm64-musl")?.runner).toBe("ubuntu-24.04-arm")
    expect(matrix.find((item) => item.target === "windows-arm64")?.runner).toBe("windows-11-arm")
    expect(matrix.find((item) => item.target === "darwin-x64-baseline")?.runner).toBe("macos-15-intel")
  })
})
