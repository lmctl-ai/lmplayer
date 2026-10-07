#!/usr/bin/env bun
import { $ } from "bun"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { appendFileSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { allTargets, targetForSuffix, targetName, targetSuffix } from "../packages/opencode/script/build-target"
import { assemblePlatform, assembleWrapper, packageNameForTarget } from "../packages/opencode/script/npm-package"
import config from "./lmplayer-release.json"
import sourcePackage from "../packages/opencode/package.json"

const root = path.resolve(import.meta.dir, "..")
const output = path.join(root, ".lmplayer-release")
const dist = path.join(root, "packages/opencode/dist")
const registry = "https://registry.npmjs.org"

export function nextVersion(base: string, versions: string[]) {
  assert.match(base, /^\d+\.\d+\.\d+$/)
  const highest = versions.filter((version) => /^\d+\.\d+\.\d+$/.test(version)).sort((a, b) => {
    const first = a.split(".").map(Number)
    const second = b.split(".").map(Number)
    return first[0] - second[0] || first[1] - second[1] || first[2] - second[2]
  }).at(-1)
  if (!highest) return base
  const a = highest.split(".").map(Number)
  const b = base.split(".").map(Number)
  if (b[0] > a[0] || (b[0] === a[0] && b[1] > a[1]) || (b[0] === a[0] && b[1] === a[1] && b[2] > a[2])) return base
  return `${a[0]}.${a[1]}.${a[2] + 1}`
}

export function buildMatrix() {
  return allTargets.map((target) => ({
    target: targetSuffix(target),
    runner: target.os === "linux"
      ? target.arch === "arm64" ? "ubuntu-24.04-arm" : "ubuntu-24.04"
      : target.os === "darwin"
        ? target.arch === "arm64" ? "macos-15" : "macos-15-intel"
        : target.arch === "arm64" ? "windows-11-arm" : "windows-2025",
  }))
}

type RegistryPackage = { versions: Record<string, { dist: { integrity: string } }>; "dist-tags"?: Record<string, string> }

async function metadata(name: string): Promise<RegistryPackage | null> {
  const response = await fetch(`${registry}/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(30_000) })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`npm metadata ${name}: HTTP ${response.status}`)
  return response.json()
}

async function plan() {
  const names = [config.name, ...allTargets.map((target) => packageNameForTarget(target, config.name))]
  const packages = await Promise.all(names.map(metadata))
  const base = sourcePackage.version
  const version = process.env.LMPLAYER_VERSION || nextVersion(base, packages.flatMap((item) => Object.keys(item?.versions ?? {})))
  assert.match(version, /^\d+\.\d+\.\d+$/, "release version must be x.y.z")
  const modelResponse = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(60_000) })
  if (!modelResponse.ok) throw new Error(`models.dev snapshot: HTTP ${modelResponse.status}`)
  const models = await modelResponse.text()
  JSON.parse(models)
  await mkdir(output, { recursive: true })
  await writeFile(path.join(output, "models.json"), models)
  await writeFile(path.join(output, "plan.json"), JSON.stringify({ version, ...config, packages: names, latestBefore: packages[0]?.["dist-tags"]?.latest, source: process.env.GITHUB_SHA }, null, 2))
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
    `version=${version}\nmatrix=${JSON.stringify({ include: buildMatrix() })}\nwindows_matrix=${JSON.stringify({ include: buildMatrix().filter((item) => item.target.startsWith("windows-")) })}\n`)
  console.log(`Planned ${names.length} packages at ${version}, tag ${config.channel}`)
}

async function pack(directory: string) {
  const destination = path.join(output, "tarballs")
  await mkdir(destination, { recursive: true })
  const packed: { filename: string; name: string; version: string; integrity: string; files: { path: string }[] }[] = JSON.parse(await $`npm pack --json --pack-destination ${destination}`.cwd(directory).text())
  const item = packed[0]
  assert.ok(item.files.every((file) => file.path === "package.json" || file.path === "LICENSE" || /^bin\/lmplayer(?:\.exe)?$/.test(file.path)), "unexpected file in npm tarball")
  assert.equal(item.name === config.name || allTargets.some((target) => packageNameForTarget(target, config.name) === item.name), true, "refusing to package an upstream name")
  console.log(`Packed ${item.name}@${item.version}: ${item.filename}`)
}

async function platform(suffix: string) {
  const target = targetForSuffix(suffix)
  assert.ok(target, `Unknown target ${suffix}`)
  const release = await Bun.file(path.join(output, "plan.json")).json()
  const result = await assemblePlatform(target, release.version, dist, config.name)
  await pack(result.directory)
}

async function unpack(suffix: string) {
  const release = await Bun.file(path.join(output, "plan.json")).json()
  const target = targetForSuffix(suffix)
  assert.ok(target)
  const filename = `${config.name.replace(/^@/, "").replaceAll("/", "-")}-${suffix}-${release.version}.tgz`
  const destination = path.join(dist, targetName(target))
  await mkdir(destination, { recursive: true })
  // Git Bash's tar treats a Windows drive letter as a remote archive host.
  const tar = process.platform === "win32"
    ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar"
  await $`${tar} -xzf ${path.join(output, "tarballs", filename)} -C ${destination} --strip-components=1`
}

async function assemble() {
  const release = await Bun.file(path.join(output, "plan.json")).json()
  for (const target of allTargets) await unpack(targetSuffix(target))
  const wrapper = await assembleWrapper(release.version, dist, config.name)
  await pack(wrapper.directory)
}

async function publish() {
  const release = await Bun.file(path.join(output, "plan.json")).json()
  assert.equal(release.name, config.name)
  assert.equal(release.channel, config.channel)
  const current = (await metadata(config.name))?.["dist-tags"]?.[config.channel]
  if (current && current !== release.version) {
    assert.equal(nextVersion(release.version, [current]), release.version, `refusing to move ${config.channel} backward from ${current}`)
  }
  const names = [...allTargets.map((target) => packageNameForTarget(target, config.name)), config.name]
  const files = await readdir(path.join(output, "tarballs"))
  assert.equal(files.filter((file) => file.endsWith(".tgz")).length, names.length, "incomplete release: all variants and wrapper are required")
  for (const name of names) {
    const file = path.join(output, "tarballs", `${name.replace(/^@/, "").replaceAll("/", "-")}-${release.version}.tgz`)
    const integrity = `sha512-${createHash("sha512").update(await readFile(file)).digest("base64")}`
    const existing = (await metadata(name))?.versions?.[release.version]
    if (existing) {
      assert.equal(existing.dist.integrity, integrity, `refusing different bytes for existing ${name}@${release.version}`)
      console.log(`Already published exact artifact: ${name}@${release.version}`)
      continue
    }
    // Wrapper is last, so its optional dependencies are published before it becomes visible.
    const child = Bun.spawn([
      "npm", "publish", file, "--access", "public", "--tag", config.channel,
      ...(process.env.GITHUB_ACTIONS === "true" ? ["--provenance"] : []),
    ], { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
    assert.equal(await child.exited, 0, `npm publish failed for ${name}`)
  }
}

async function verify() {
  const release = await Bun.file(path.join(output, "plan.json")).json()
  const consumer = await mkdtemp(path.join(tmpdir(), "lmplayer-npm-"))
  await writeFile(path.join(consumer, "package.json"), JSON.stringify({ name: "lmplayer-consumer-smoke", private: true }))
  const deadline = Date.now() + 600_000
  for (;;) {
    try {
      for (const name of [config.name, ...allTargets.map((target) => packageNameForTarget(target, config.name))]) {
        const file = path.join(output, "tarballs", `${name.replace(/^@/, "").replaceAll("/", "-")}-${release.version}.tgz`)
        const expected = `sha512-${createHash("sha512").update(await readFile(file)).digest("base64")}`
        const published = await metadata(name)
        assert.equal(published?.versions?.[release.version]?.dist.integrity, expected, `${name} registry bytes not ready or different`)
      }
      await $`npm install --prefix ${consumer} ${`${config.name}@${release.version}`} --ignore-scripts --no-audit --no-fund`.quiet()
      // npm may exit successfully even when a not-yet-visible optional binary failed.
      const binary = path.join(consumer, "node_modules/.bin/lmplayer")
      assert.equal((await $`${binary} --version`.text()).trim(), release.version)
      await $`${binary} --help`.quiet()
      break
    } catch (error) {
      if (Date.now() >= deadline) throw error
      console.log(`Registry/install not ready; read-only retry in 30 seconds: ${error instanceof Error ? error.message : String(error)}`)
      await rm(path.join(consumer, "node_modules"), { recursive: true, force: true })
      await rm(path.join(consumer, "package-lock.json"), { force: true })
      await Bun.sleep(30_000)
    }
  }
  const tags = (await metadata(config.name))?.["dist-tags"]
  assert.equal(tags?.[config.channel], release.version)
  if (config.channel !== "latest") assert.equal(tags?.latest, release.latestBefore, "latest changed during the staging release")
  console.log(`Verified ${config.name}@${release.version} from npm, including exact platform artifacts and wrapper execution`)
}

async function smoke(suffix: string) {
  const target = targetForSuffix(suffix)
  assert.ok(target)
  const release = await Bun.file(path.join(output, "plan.json")).json()
  const binary = path.join(dist, targetName(target), "bin", target.os === "win32" ? "lmplayer.exe" : "lmplayer")
  if (target.os !== "win32") await chmod(binary, 0o755)
  if (target.abi === "musl") {
    const directory = path.dirname(binary)
    const mount = `${directory}:/release:ro`
    const version = await $`docker run --rm -v ${mount} alpine:3.22 sh -c 'apk add --no-cache libgcc libstdc++ >/dev/null && /release/lmplayer --version'`.text()
    assert.equal(version.trim().split("\n").at(-1), release.version)
    await $`docker run --rm -v ${mount} alpine:3.22 sh -c 'apk add --no-cache libgcc libstdc++ >/dev/null && /release/lmplayer --help >/dev/null'`
    return
  }
  assert.equal((await $`${binary} --version`.text()).trim(), release.version)
  await $`${binary} --help`.quiet()
}

if (import.meta.main) {
  const action = process.argv[2]
  if (action === "plan") await plan()
  else if (action === "platform") await platform(process.argv[3])
  else if (action === "assemble") await assemble()
  else if (action === "unpack") await unpack(process.argv[3])
  else if (action === "publish") await publish()
  else if (action === "verify") await verify()
  else if (action === "smoke") await smoke(process.argv[3])
  else throw new Error("Usage: bun script/lmplayer-release.ts plan|platform <target>|unpack <target>|assemble|publish|verify|smoke <target>")
}
