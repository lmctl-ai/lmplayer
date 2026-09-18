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
    expect(content).toContain('const aliasTarget = path.join(__dirname, "bin", platform === "windows" ? "lmcode.exe" : "lmcode")')

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
    expect(content).toContain('lmcode: "./bin/lmcode"')
    expect(content).toContain('[pkg.name]: `./bin/${pkg.name}.exe`')
    expect(content).toContain('await Bun.file(`./dist/${pkg.name}/bin/lmplayer`).write(stubScript)')
    expect(content).toContain('await Bun.file(`./dist/${pkg.name}/bin/lmplayer.exe`).write(stubScript)')
    expect(content).toContain('await Bun.file(`./dist/${pkg.name}/bin/lmcode`).write(stubScript)')

    // PKGBUILD recipe installs lmplayer and symlinks lmcode/opencode
    expect(content).toContain('install -Dm755 ./lmplayer "${pkgdir}/usr/bin/lmplayer"')
    expect(content).toContain('ln -sf lmplayer "${pkgdir}/usr/bin/opencode"')
    expect(content).toContain('ln -sf lmplayer "${pkgdir}/usr/bin/lmcode"')

    // Homebrew formula installs lmplayer and symlinks lmcode/opencode
    expect(content).toContain('bin.install "lmplayer"')
    expect(content).toContain('bin.install_symlink "lmplayer" => "opencode"')
    expect(content).toContain('bin.install_symlink "lmplayer" => "lmcode"')
  })

  test("build.ts provisions lmcode and opencode aliases alongside lmplayer", () => {
    const buildPath = path.resolve(import.meta.dir, "../../script/build.ts")
    const content = fs.readFileSync(buildPath, "utf8")

    expect(content).toContain('outfile: `dist/${name}/bin/lmplayer`')
    expect(content).toContain('for (const alias of ["lmcode", "opencode"])')
    expect(content).toContain('await $`cp ${primaryBin} ${aliasBin}`.nothrow()')
  })

  test("Dockerfile targets lmplayer binary and entrypoint with alias symlinks", () => {
    const dockerPath = path.resolve(import.meta.dir, "../../Dockerfile")
    const content = fs.readFileSync(dockerPath, "utf8")

    expect(content).toContain("COPY dist/opencode-linux-x64-baseline-musl/bin/lmplayer /usr/local/bin/lmplayer")
    expect(content).toContain("COPY dist/opencode-linux-arm64-musl/bin/lmplayer /usr/local/bin/lmplayer")
    expect(content).toContain("ENTRYPOINT [\"lmplayer\"]")
    expect(content).toContain("ln -s /usr/local/bin/lmplayer /usr/local/bin/lmcode")
    expect(content).toContain("ln -s /usr/local/bin/lmplayer /usr/local/bin/opencode")
  })

  test("postinstall.mjs checks lmplayer platform packages before opencode packages", () => {
    const postinstallPath = path.resolve(import.meta.dir, "../../script/postinstall.mjs")
    const content = fs.readFileSync(postinstallPath, "utf8")

    expect(content).toContain('const lmplayerBase = `lmplayer-${platform}-${arch}`')
    expect(content).toContain("const candidatesFor = (prefix) => {")
    expect(content).toContain("[...candidatesFor(lmplayerBase), ...candidatesFor(base)]")
  })

  test("publish.ts generates both lmplayer and opencode-ai wrapper packages", () => {
    const publishPath = path.resolve(import.meta.dir, "../../script/publish.ts")
    const content = fs.readFileSync(publishPath, "utf8")

    expect(content).toContain("const lmplayerBinaries = Object.fromEntries(")
    expect(content).toContain("const opencodeBinaries = Object.fromEntries(")
    expect(content).toContain('await $`mkdir -p ./dist/lmplayer`')
    expect(content).toContain('name: "lmplayer"')
    expect(content).toContain('await publish(`./dist/${pkg.name}`, `${pkg.name}-ai`, version)')
    expect(content).toContain('await publish(`./dist/lmplayer`, "lmplayer", version)')
  })

  test("build.ts provisions lmplayer platform packages alongside opencode packages", () => {
    const buildPath = path.resolve(import.meta.dir, "../../script/build.ts")
    const content = fs.readFileSync(buildPath, "utf8")

    expect(content).toContain('const lmplayerName = name.replace(new RegExp(`^${pkg.name}`), "lmplayer")')
    expect(content).toContain("binaries[lmplayerName] = Script.version")
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

  test("platform package resolution prefers lmplayer packages over opencode packages", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "packaging-platform-test-"))
    try {
      const nodeModules = path.join(tmp, "node_modules")
      const lmplayerPkg = path.join(nodeModules, "lmplayer-linux-x64", "bin")
      const opencodePkg = path.join(nodeModules, "opencode-linux-x64", "bin")

      fs.mkdirSync(lmplayerPkg, { recursive: true })
      fs.mkdirSync(opencodePkg, { recursive: true })

      const resolveCandidate = (candidates: string[]) => {
        for (const candidate of candidates) {
          const binPath = path.join(nodeModules, candidate, "bin", "lmplayer")
          if (fs.existsSync(binPath)) return candidate
        }
        return undefined
      }

      const candidates = ["lmplayer-linux-x64", "opencode-linux-x64"]

      // 1. Only opencode package exists with binary
      fs.writeFileSync(path.join(opencodePkg, "lmplayer"), "#!/bin/sh\nexit 0")
      expect(resolveCandidate(candidates)).toBe("opencode-linux-x64")

      // 2. Both exist -> lmplayer takes precedence
      fs.writeFileSync(path.join(lmplayerPkg, "lmplayer"), "#!/bin/sh\nexit 0")
      expect(resolveCandidate(candidates)).toBe("lmplayer-linux-x64")
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
