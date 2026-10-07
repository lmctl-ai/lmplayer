#!/usr/bin/env node

const childProcess = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const packageBase = process.env.LMPLAYER_NPM_PACKAGE || "@lmctl-ai/lmplayer"

function platformName(platform = process.platform) {
  return platform === "win32" ? "windows" : platform
}

function archName(arch = process.arch) {
  if (arch === "arm") return "arm"
  return arch
}

function supportsAvx2(platform = process.platform, arch = process.arch) {
  if (arch !== "x64") return false

  if (platform === "linux") {
    try {
      return /(^|\s)avx2(\s|$)/i.test(fs.readFileSync("/proc/cpuinfo", "utf8"))
    } catch {
      return false
    }
  }

  if (platform === "darwin") {
    try {
      const result = childProcess.spawnSync("sysctl", ["-n", "hw.optional.avx2_0"], {
        encoding: "utf8",
        timeout: 1500,
      })
      return result.status === 0 && result.stdout.trim() === "1"
    } catch {
      return false
    }
  }

  if (platform === "win32") {
    const command =
      '(Add-Type -MemberDefinition "[DllImport(\"\"kernel32.dll\"\")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);" -Name Kernel32 -Namespace Win32 -PassThru)::IsProcessorFeaturePresent(40)'
    for (const executable of ["powershell.exe", "pwsh.exe", "pwsh", "powershell"]) {
      try {
        const result = childProcess.spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", command], {
          encoding: "utf8",
          timeout: 3000,
          windowsHide: true,
        })
        if (result.status !== 0) continue
        const output = result.stdout.trim().toLowerCase()
        if (output === "true" || output === "1") return true
        if (output === "false" || output === "0") return false
      } catch {
        // Try the next PowerShell executable.
      }
    }
  }

  return false
}

function isMusl(platform = process.platform) {
  if (platform !== "linux") return false

  try {
    const report = process.report?.getReport?.()
    if (report?.header?.glibcVersionRuntime) return false
  } catch {
    // Continue with the file and ldd probes below.
  }

  try {
    if (fs.existsSync("/etc/alpine-release")) return true
  } catch {
    // Ignore a blocked filesystem probe.
  }

  try {
    const result = childProcess.spawnSync("ldd", ["--version"], { encoding: "utf8", timeout: 1500 })
    return `${result.stdout || ""}${result.stderr || ""}`.toLowerCase().includes("musl")
  } catch {
    return false
  }
}

function packageNameFor(platform = process.platform, arch = process.arch) {
  const suffix = `${platformName(platform)}-${archName(arch)}`
  if (arch === "x64" && !supportsAvx2(platform, arch)) {
    return `${packageBase}-${suffix}-baseline${platform === "linux" && isMusl(platform) ? "-musl" : ""}`
  }
  return `${packageBase}-${suffix}${platform === "linux" && isMusl(platform) ? "-musl" : ""}`
}

function resolveBinary(packageName, platform = process.platform) {
  let packageJson
  try {
    packageJson = require.resolve(`${packageName}/package.json`, { paths: [__dirname] })
  } catch {
    throw new Error(`The native package ${packageName} was not installed for this platform.`)
  }

  const binary = path.join(path.dirname(packageJson), "bin", platform === "win32" ? "lmplayer.exe" : "lmplayer")
  if (!fs.existsSync(binary) || fs.statSync(binary).size === 0) {
    throw new Error(`The native package ${packageName} does not contain a usable lmplayer binary.`)
  }
  return binary
}

function main() {
  const packageName = packageNameFor()
  const binary = resolveBinary(packageName)
  const child = childProcess.spawn(binary, process.argv.slice(2), { stdio: "inherit", windowsHide: false })
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      if (!child.killed) child.kill(signal)
    })
  }
  child.on("error", (error) => {
    console.error(`Unable to start ${packageName}: ${error.message}`)
    process.exitCode = 1
  })
  child.on("exit", (code, signal) => {
    if (signal) {
      const signalCode = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[signal] || 1
      process.exitCode = 128 + signalCode
      return
    }
    process.exitCode = code ?? 1
  })
}

module.exports = { archName, isMusl, packageNameFor, platformName, resolveBinary, supportsAvx2 }

if (require.main === module) main()
