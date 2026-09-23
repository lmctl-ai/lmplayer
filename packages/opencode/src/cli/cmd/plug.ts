import { intro, log, outro, spinner } from "@clack/prompts"
import { Effect } from "effect"
import path from "node:path"
import os from "node:os"

import { ConfigPaths } from "@/config/paths"
import { Global } from "@opencode-ai/core/global"
import { installPlugin, patchPluginConfig, readPluginManifest } from "../../plugin/install"
import { resolvePluginTarget } from "../../plugin/shared"
import { errorMessage } from "../../util/error"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"
import { UI } from "../ui"
import { effectCmd } from "../effect-cmd"
import { InstanceRef } from "@/effect/instance-ref"

type Spin = {
  start: (msg: string) => void
  stop: (msg: string, code?: number) => void
}

export type PlugDeps = {
  spinner: () => Spin
  log: {
    error: (msg: string) => void
    info: (msg: string) => void
    success: (msg: string) => void
  }
  resolve: (spec: string) => Promise<string>
  readText: (file: string) => Promise<string>
  write: (file: string, text: string) => Promise<void>
  exists: (file: string) => Promise<boolean>
  files: (dir: string, name: "opencode" | "tui") => string[]
  global: string
}

export type PlugInput = {
  mod: string
  global?: boolean
  force?: boolean
}

export type PlugCtx = {
  vcs?: string
  worktree: string
  directory: string
}

const defaultPlugDeps: PlugDeps = {
  spinner: () => spinner(),
  log: {
    error: (msg) => log.error(msg),
    info: (msg) => log.info(msg),
    success: (msg) => log.success(msg),
  },
  resolve: (spec) => resolvePluginTarget(spec),
  readText: (file) => Filesystem.readText(file),
  write: async (file, text) => {
    await Filesystem.write(file, text)
  },
  exists: (file) => Filesystem.exists(file),
  files: (dir, name) => ConfigPaths.fileInDirectory(dir, name),
  global: Global.Path.config,
}

function cause(err: unknown) {
  if (!err || typeof err !== "object") return
  if (!("cause" in err)) return
  return (err as { cause?: unknown }).cause
}

export type PlugTaskResult =
  | {
      ok: true
      module: string
      scope: "global" | "local"
      directory: string
      targets: string[]
      items: Array<{ kind: "server" | "tui"; mode: "noop" | "add" | "replace"; file: string }>
    }
  | {
      ok: false
      module: string
      error: string
    }

export function createPlugTaskDetailed(input: PlugInput, dep: PlugDeps = defaultPlugDeps) {
  const mod = input.mod
  const force = Boolean(input.force)
  const global = Boolean(input.global)

  return async (ctx: PlugCtx): Promise<PlugTaskResult> => {
    const install = dep.spinner()
    install.start("Installing plugin package...")
    const target = await installPlugin(mod, dep)
    if (!target.ok) {
      install.stop("Install failed", 1)
      dep.log.error(`Could not install "${mod}"`)
      const hit = cause(target.error) ?? target.error
      let errorMsg = `Could not install "${mod}"`
      if (hit instanceof Process.RunFailedError) {
        const lines = hit.stderr
          .toString()
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
        const errs = lines.filter((line) => line.startsWith("error:")).map((line) => line.replace(/^error:\s*/, ""))
        const detail = errs[0] ?? lines.at(-1)
        if (detail) {
          dep.log.error(detail)
          errorMsg = detail
        }
        if (lines.some((line) => line.includes("No version matching"))) {
          dep.log.info("This package depends on a version that is not available in your npm registry.")
          dep.log.info("Check npm registry/auth settings and try again.")
        }
      }
      if (!(hit instanceof Process.RunFailedError)) {
        const msg = errorMessage(hit)
        dep.log.error(msg)
        errorMsg = msg
      }
      return { ok: false, module: mod, error: errorMsg }
    }
    install.stop("Plugin package ready")

    const inspect = dep.spinner()
    inspect.start("Reading plugin manifest...")
    const manifest = await readPluginManifest(target.target)
    if (!manifest.ok) {
      if (manifest.code === "manifest_read_failed") {
        inspect.stop("Manifest read failed", 1)
        dep.log.error(`Installed "${mod}" but failed to read ${manifest.file}`)
        const msg = errorMessage(cause(manifest.error) ?? manifest.error)
        dep.log.error(msg)
        return { ok: false, module: mod, error: `Installed "${mod}" but failed to read ${manifest.file}: ${msg}` }
      }

      if (manifest.code === "manifest_no_targets") {
        inspect.stop("No plugin targets found", 1)
        const err = `"${mod}" does not expose plugin entrypoints in package.json`
        dep.log.error(err)
        dep.log.info(
          'Expected one of: exports["./tui"], exports["./server"], package.json main for server, or package.json["oc-themes"] for tui themes.',
        )
        return { ok: false, module: mod, error: err }
      }

      inspect.stop("Manifest read failed", 1)
      return { ok: false, module: mod, error: "Manifest read failed" }
    }

    inspect.stop(
      `Detected ${manifest.targets.map((item) => item.kind).join(" + ")} target${manifest.targets.length === 1 ? "" : "s"}`,
    )

    const patch = dep.spinner()
    patch.start("Updating plugin config...")
    const out = await patchPluginConfig(
      {
        spec: mod,
        targets: manifest.targets,
        force,
        global,
        vcs: ctx.vcs,
        worktree: ctx.worktree,
        directory: ctx.directory,
        config: dep.global,
      },
      dep,
    )
    if (!out.ok) {
      if (out.code === "invalid_json") {
        patch.stop(`Failed updating ${out.kind} config`, 1)
        const err = `Invalid JSON in ${out.file} (${out.parse} at line ${out.line}, column ${out.col})`
        dep.log.error(err)
        dep.log.info("Fix the config file and run the command again.")
        return { ok: false, module: mod, error: err }
      }

      patch.stop("Failed updating plugin config", 1)
      const err = errorMessage(out.error)
      dep.log.error(err)
      return { ok: false, module: mod, error: err }
    }
    patch.stop("Plugin config updated")
    for (const item of out.items) {
      if (item.mode === "noop") {
        dep.log.info(`Already configured in ${item.file}`)
        continue
      }
      if (item.mode === "replace") {
        dep.log.info(`Replaced in ${item.file}`)
        continue
      }
      dep.log.info(`Added to ${item.file}`)
    }

    dep.log.success(`Installed ${mod}`)
    dep.log.info(global ? `Scope: global (${out.dir})` : `Scope: local (${out.dir})`)
    return {
      ok: true,
      module: mod,
      scope: global ? "global" : "local",
      directory: out.dir,
      targets: manifest.targets.map((item) => item.kind),
      items: out.items,
    }
  }
}

export function createPlugTask(input: PlugInput, dep: PlugDeps = defaultPlugDeps) {
  const task = createPlugTaskDetailed(input, dep)
  return async (ctx: PlugCtx): Promise<boolean> => {
    const res = await task(ctx)
    return res.ok
  }
}

const silentSpin: Spin = {
  start: () => {},
  stop: () => {},
}

const silentPlugDeps: PlugDeps = {
  ...defaultPlugDeps,
  spinner: () => silentSpin,
  log: {
    error: () => {},
    info: () => {},
    success: () => {},
  },
}

export const PluginCommand = effectCmd({
  command: "plugin <module>",
  aliases: ["plug"],
  describe: "install plugin and update config",
  builder: (yargs) =>
    yargs
      .positional("module", {
        type: "string",
        describe: "npm module name",
      })
      .option("global", {
        alias: ["g"],
        type: "boolean",
        default: false,
        describe: "install in global config",
      })
      .option("force", {
        alias: ["f"],
        type: "boolean",
        default: false,
        describe: "replace existing plugin version",
      })
      .option("json", {
        type: "boolean",
        describe: "output JSON",
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write plugin install result to output file path",
      }),
  handler: Effect.fn("Cli.plug")(function* (args: {
    module?: string
    global?: boolean
    force?: boolean
    json?: boolean
    output?: string
    g?: boolean
    f?: boolean
    o?: string
  }) {
    const mod = String(args.module ?? "").trim()
    const isGlobal = Boolean(args.global ?? args.g)
    const isForce = Boolean(args.force ?? args.f)
    const isJson = Boolean(args.json)
    const output = args.output ?? args.o

    if (!mod) {
      if (isJson) {
        process.stdout.write(
          JSON.stringify(
            {
              ok: false,
              error: "module is required",
            },
            null,
            2,
          ) + os.EOL,
        )
      } else {
        UI.error("module is required")
      }
      process.exitCode = 1
      return
    }

    const isNonInteractive = Boolean(isJson || output)
    if (!isNonInteractive) {
      UI.empty()
      intro(`Install plugin ${mod}`)
    }

    const run = createPlugTaskDetailed(
      {
        mod,
        global: isGlobal,
        force: isForce,
      },
      isNonInteractive ? silentPlugDeps : defaultPlugDeps,
    )

    const ctx = yield* InstanceRef
    if (!ctx) return
    const res = yield* Effect.promise(() =>
      run({
        vcs: ctx.project.vcs,
        worktree: ctx.worktree,
        directory: ctx.directory,
      }),
    )

    if (!isNonInteractive) {
      outro("Done")
    }

    if (output) {
      const resolved = path.resolve(output)
      yield* Effect.promise(async () => {
        const fs = await import("node:fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        if (isJson) {
          await fs.writeFile(resolved, JSON.stringify(res, null, 2) + os.EOL, "utf-8")
        } else {
          await fs.writeFile(
            resolved,
            (res.ok
              ? `Installed ${res.module} (${res.scope}: ${res.directory})`
              : `Error: ${res.error}`) + os.EOL,
            "utf-8",
          )
        }
      })
      UI.println(`Wrote plugin install result to ${resolved}`)
      if (!res.ok) process.exitCode = 1
      return
    }

    if (isJson) {
      process.stdout.write(JSON.stringify(res, null, 2) + os.EOL)
      if (!res.ok) process.exitCode = 1
      return
    }

    if (!res.ok) process.exitCode = 1
  }),
})
