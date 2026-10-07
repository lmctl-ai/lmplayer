import { describe, expect, test } from "bun:test"
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { allTargets, targetName } from "../../script/build-target"
import {
  NPM_PACKAGE_NAME,
  assemblePlatform,
  assembleWrapper,
  packageNameForTarget,
} from "../../script/npm-package"

const require = createRequire(import.meta.url)
const launcher = require("../../script/npm-launcher.cjs") as {
  packageNameFor: () => string
}

describe("lmplayer npm packages", () => {
  test("assembles all target metadata and rejects incomplete versions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lmplayer-npm-"))
    try {
      for (const target of allTargets) {
        const binary = path.join(root, targetName(target), "bin", target.os === "win32" ? "lmplayer.exe" : "lmplayer")
        await mkdir(path.dirname(binary), { recursive: true })
        await cp(process.execPath, binary)
      }
      await Promise.all(allTargets.map((target) => assemblePlatform(target, "2.3.4", root)))
      const wrapper = await assembleWrapper("2.3.4", root)
      const packageJson = JSON.parse(await readFile(path.join(wrapper.directory, "package.json"), "utf8"))
      expect(Object.keys(packageJson.optionalDependencies)).toHaveLength(12)
      expect(Object.keys(packageJson.optionalDependencies)).toEqual(
        allTargets.map((target) => packageNameForTarget(target)),
      )
      for (const target of allTargets) {
        const metadata = JSON.parse(await readFile(path.join(root, targetName(target), "package.json"), "utf8"))
        expect(metadata).toMatchObject({
          name: packageNameForTarget(target),
          version: "2.3.4",
          os: [target.os],
          cpu: [target.arch],
        })
        if (target.abi) expect(metadata.libc).toEqual([target.abi])
        expect(metadata.name).not.toMatch(/(^|\/)opencode/)
      }
      await expect(assembleWrapper("2.3.5", root)).rejects.toThrow("must be")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("launcher executes the exact host optional package", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lmplayer-launcher-"))
    try {
      const selected = launcher.packageNameFor()
      for (const target of allTargets) {
        const binary = path.join(root, targetName(target), "bin", target.os === "win32" ? "lmplayer.exe" : "lmplayer")
        await mkdir(path.dirname(binary), { recursive: true })
        if (packageNameForTarget(target) === selected) await cp(process.execPath, binary)
        else await writeFile(binary, "non-host fixture")
        await chmod(binary, 0o755)
        await assemblePlatform(target, "2.3.4", root)
      }
      const wrapper = await assembleWrapper("2.3.4", root)
      const packageDirectory = path.join(root, "node_modules", ...selected.split("/"))
      await cp(path.join(root, selected.split("/").at(-1)!), packageDirectory, { recursive: true })
      const passthrough = Bun.spawnSync(
        [process.execPath, path.join(wrapper.directory, "bin", "lmplayer"), "--eval", `console.log(${JSON.stringify(selected)})`],
        { cwd: root, env: { ...process.env, LMPLAYER_NPM_PACKAGE: NPM_PACKAGE_NAME }, stdout: "pipe", stderr: "pipe" },
      )
      expect(passthrough.exitCode).toBe(0)
      expect(new TextDecoder().decode(passthrough.stdout).trim()).toBe(selected)

      const failed = Bun.spawnSync(
        [process.execPath, path.join(wrapper.directory, "bin", "lmplayer"), "--eval", "process.exit(23)"],
        { cwd: root, env: { ...process.env, LMPLAYER_NPM_PACKAGE: NPM_PACKAGE_NAME }, stdout: "pipe", stderr: "pipe" },
      )
      expect(failed.exitCode).toBe(23)

      if (process.platform !== "win32") {
        const signaled = Bun.spawn(
          [
            process.execPath,
            path.join(wrapper.directory, "bin", "lmplayer"),
            "--eval",
            'process.on("SIGTERM", () => process.exit(17)); process.stdout.write("ready\\n"); setInterval(() => {}, 1000)',
          ],
          { cwd: root, env: { ...process.env, LMPLAYER_NPM_PACKAGE: NPM_PACKAGE_NAME }, stdout: "pipe", stderr: "pipe" },
        )
        let output = ""
        const reader = signaled.stdout.getReader()
        while (!output.includes("ready")) {
          const chunk = await reader.read()
          if (chunk.done) break
          output += new TextDecoder().decode(chunk.value)
          if (output.includes("ready")) {
            signaled.kill("SIGTERM")
          }
        }
        expect(await signaled.exited).toBe(17)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
