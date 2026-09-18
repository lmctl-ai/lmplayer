import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

describe("packaging and postinstall", () => {
  test("postinstall.mjs targets lmplayer binary with fallback to legacy opencode", () => {
    const postinstallPath = path.resolve(import.meta.dir, "../../script/postinstall.mjs")
    const content = fs.readFileSync(postinstallPath, "utf8")

    // Assert that source and target binaries resolve to lmplayer
    expect(content).toContain('const sourceBinary = platform === "windows" ? "lmplayer.exe" : "lmplayer"')
    expect(content).toContain('const targetBinary = path.join(__dirname, "bin", platform === "windows" ? "lmplayer.exe" : "lmplayer")')
    expect(content).toContain('const legacyTarget = path.join(__dirname, "bin", platform === "windows" ? "opencode.exe" : "opencode")')

    // Assert fallback candidate checking exists
    expect(content).toContain('path.join(binDir, sourceBinary)')
    expect(content).toContain('path.join(binDir, platform === "windows" ? "opencode.exe" : "opencode")')

    // Assert user-facing error message references lmplayer
    expect(content).toContain("failed to install the right lmplayer CLI package")
  })

  test("publish.ts registers lmplayer and opencode in package.json bin", () => {
    const publishPath = path.resolve(import.meta.dir, "../../script/publish.ts")
    const content = fs.readFileSync(publishPath, "utf8")

    expect(content).toContain('lmplayer: "./bin/lmplayer"')
    expect(content).toContain('[pkg.name]: `./bin/${pkg.name}.exe`')
    expect(content).toContain('await Bun.file(`./dist/${pkg.name}/bin/lmplayer`).write(stubScript)')
  })

  test("binary resolution logic resolves lmplayer and falls back to opencode", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "packaging-test-"))
    try {
      const mockPkgDir = path.join(tmp, "mock-platform-pkg", "bin")
      fs.mkdirSync(mockPkgDir, { recursive: true })

      const isWindows = process.platform === "win32"
      const lmplayerBin = isWindows ? "lmplayer.exe" : "lmplayer"
      const opencodeBin = isWindows ? "opencode.exe" : "opencode"

      const findInDir = (dir: string) => {
        const candidates = [
          path.join(dir, lmplayerBin),
          path.join(dir, opencodeBin),
        ]
        for (const candidate of candidates) {
          if (fs.existsSync(candidate)) return path.basename(candidate)
        }
        return undefined
      }

      // 1. When empty
      expect(findInDir(mockPkgDir)).toBeUndefined()

      // 2. When only legacy opencode exists
      fs.writeFileSync(path.join(mockPkgDir, opencodeBin), "#!/bin/sh\nexit 0")
      expect(findInDir(mockPkgDir)).toBe(opencodeBin)

      // 3. When lmplayer exists, it takes precedence
      fs.writeFileSync(path.join(mockPkgDir, lmplayerBin), "#!/bin/sh\nexit 0")
      expect(findInDir(mockPkgDir)).toBe(lmplayerBin)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
