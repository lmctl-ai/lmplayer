#!/usr/bin/env bun

import { chmod, copyFile, mkdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { allTargets, targetName, targetSuffix, type BuildTarget } from "./build-target"

export const NPM_PACKAGE_NAME = "@lmctl-ai/lmplayer"
const repository = "https://github.com/lmctl-ai/lmplayer.git"
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const defaultDist = path.resolve(scriptDir, "../dist")
const launcher = path.join(scriptDir, "npm-launcher.cjs")
const license = path.resolve(scriptDir, "../../../LICENSE")

type PackageInfo = {
  name: string
  version: string
  os?: string[]
  cpu?: string[]
  libc?: string[]
}

export function packageNameForTarget(target: BuildTarget, base = NPM_PACKAGE_NAME) {
  return `${base}-${targetSuffix(target)}`
}

export async function assemblePlatform(
  target: BuildTarget,
  version: string,
  dist = defaultDist,
  base = NPM_PACKAGE_NAME,
) {
  requireVersion(version)
  const suffix = targetSuffix(target)
  const directory = path.join(dist, targetName(target))
  const binary = path.join(directory, "bin", target.os === "win32" ? "lmplayer.exe" : "lmplayer")
  await requireNonEmptyFile(binary, `missing ${suffix} binary`)
  await mkdir(directory, { recursive: true })
  await writePackageJson(directory, {
    name: packageNameForTarget(target, base),
    version,
    license: "MIT",
    repository: { type: "git", url: repository },
    files: ["bin", "LICENSE"],
    os: [target.os],
    cpu: [target.arch],
    ...(target.os === "linux" ? { libc: [target.abi ?? "glibc"] } : {}),
  })
  await copyLicense(directory)
  if (target.os !== "win32") await chmod(binary, 0o755)
  return { directory, name: packageNameForTarget(target, base), version, binary }
}

export async function assembleWrapper(version: string, dist = defaultDist, base = NPM_PACKAGE_NAME) {
  requireVersion(version)
  const packages = await Promise.all(
    allTargets.map(async (target) => {
      const directory = path.join(dist, targetName(target))
      const metadata = await readPackageJson(directory)
      const expectedName = packageNameForTarget(target, base)
      if (metadata.name !== expectedName || metadata.version !== version) {
        throw new Error(`${targetSuffix(target)} must be ${expectedName}@${version}`)
      }
      if (metadata.os?.length !== 1 || metadata.os[0] !== target.os) {
        throw new Error(`${targetSuffix(target)} has incorrect os metadata`)
      }
      if (metadata.cpu?.length !== 1 || metadata.cpu[0] !== target.arch) {
        throw new Error(`${targetSuffix(target)} has incorrect cpu metadata`)
      }
      const expectedLibc = target.os === "linux" ? [target.abi ?? "glibc"] : undefined
      if (JSON.stringify(metadata.libc) !== JSON.stringify(expectedLibc)) {
        throw new Error(`${targetSuffix(target)} has incorrect libc metadata`)
      }
      const binary = path.join(directory, "bin", target.os === "win32" ? "lmplayer.exe" : "lmplayer")
      await requireNonEmptyFile(binary, `missing ${targetSuffix(target)} binary`)
      return [expectedName, version] as const
    }),
  )

  const directory = path.join(dist, "lmplayer")
  await mkdir(path.join(directory, "bin"), { recursive: true })
  const launcherText = await Bun.file(launcher).text()
  await writeFile(
    path.join(directory, "bin", "lmplayer"),
    launcherText.replace(
      'const packageBase = process.env.LMPLAYER_NPM_PACKAGE || "@lmctl-ai/lmplayer"',
      `const packageBase = process.env.LMPLAYER_NPM_PACKAGE || ${JSON.stringify(base)}`,
    ),
  )
  await chmod(path.join(directory, "bin", "lmplayer"), 0o755)
  await writePackageJson(directory, {
    name: base,
    version,
    license: "MIT",
    repository: { type: "git", url: repository },
    files: ["bin", "LICENSE"],
    bin: { lmplayer: "./bin/lmplayer" },
    optionalDependencies: Object.fromEntries(packages),
  })
  await copyLicense(directory)
  return { directory, name: base, version, optionalDependencies: Object.fromEntries(packages) }
}

async function readPackageJson(directory: string) {
  try {
    return (await Bun.file(path.join(directory, "package.json")).json()) as PackageInfo
  } catch {
    throw new Error(`Missing platform package metadata in ${directory}`)
  }
}

async function writePackageJson(directory: string, value: Record<string, unknown>) {
  await writeFile(path.join(directory, "package.json"), `${JSON.stringify(value, null, 2)}\n`)
}

async function copyLicense(directory: string) {
  if (!(await Bun.file(license).exists())) throw new Error(`Missing repository LICENSE at ${license}`)
  await copyFile(license, path.join(directory, "LICENSE"))
}

async function requireNonEmptyFile(filepath: string, message: string) {
  try {
    if ((await stat(filepath)).size > 0) return
  } catch {
    // Convert filesystem details into an actionable assembly error.
  }
  throw new Error(message)
}

function requireVersion(version: string) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
    throw new Error(`npm package version must be plain semver: ${version || "(missing)"}`)
  }
}

if (import.meta.main) {
  const version = process.argv.find((arg) => arg.startsWith("--version="))?.slice("--version=".length)
  const dist = process.argv.find((arg) => arg.startsWith("--dist="))?.slice("--dist=".length) ?? defaultDist
  const base =
    process.argv.find((arg) => arg.startsWith("--package="))?.slice("--package=".length) ??
    process.argv.find((arg) => arg.startsWith("--name="))?.slice("--name=".length) ??
    NPM_PACKAGE_NAME
  if (!version) throw new Error("Usage: bun run script/npm-package.ts --version=<version> [--dist=<dist>]")
  await Promise.all(allTargets.map((target) => assemblePlatform(target, version, dist, base)))
  await assembleWrapper(version, dist, base)
}
