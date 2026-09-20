import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import fs from "node:fs/promises"
import { cliIt, type OpencodeCli, type SpawnOpts } from "../lib/cli-process"

describe("opencode config (cli command)", () => {
  const run = (opencode: OpencodeCli, args: string[], opts?: SpawnOpts) =>
    opencode.spawn(args, {
      ...opts,
      env: { OPENCODE_DISABLE_PROJECT_CONFIG: "", OPENCODE_CONFIG_CONTENT: "", ...opts?.env },
    })

  cliIt.concurrent(
    "sets and gets global config by default",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const setResult = yield* run(opencode, ["config", "set", "model", "test-provider/global-model"])
        opencode.expectExit(setResult, 0)
        expect(setResult.stdout).toContain('set model = "test-provider/global-model"')

        const getResult = yield* run(opencode, ["config", "get", "model"])
        opencode.expectExit(getResult, 0)
        expect(getResult.stdout.trim()).toBe("test-provider/global-model")

        const globalFileJsonc = path.join(home, ".config", "lmplayer", "opencode.jsonc")
        const globalFileJson = path.join(home, ".config", "lmplayer", "opencode.json")
        const isJsonc = yield* Effect.promise(() =>
          fs
            .stat(globalFileJsonc)
            .then(() => true)
            .catch(() => false),
        )
        const isJson = yield* Effect.promise(() =>
          fs
            .stat(globalFileJson)
            .then(() => true)
            .catch(() => false),
        )
        expect(isJsonc || isJson).toBe(true)
        const globalFile = isJsonc ? globalFileJsonc : globalFileJson
        const fileContent = JSON.parse(yield* Effect.promise(() => fs.readFile(globalFile, "utf-8")))
        expect(fileContent.model).toBe("test-provider/global-model")
      }),
    60_000,
  )

  cliIt.concurrent(
    "sets and gets project config using --project / -p",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        // Set a global model first
        const globalSet = yield* run(opencode, ["config", "set", "model", "test-provider/global-model"])
        opencode.expectExit(globalSet, 0)

        // Set project model using -p
        const projectSet = yield* run(opencode, ["config", "set", "model", "test-provider/project-model", "-p"])
        opencode.expectExit(projectSet, 0)
        expect(projectSet.stdout).toContain('set model = "test-provider/project-model"')

        // Project file is created in working directory
        const projectFile = path.join(home, "opencode.json")
        const projContent = yield* Effect.promise(() => Bun.file(projectFile).json())
        expect(projContent.model).toBe("test-provider/project-model")

        // config get model --project returns project value
        const getProj = yield* run(opencode, ["config", "get", "model", "--project"])
        opencode.expectExit(getProj, 0)
        expect(getProj.stdout.trim()).toBe("test-provider/project-model")

        // config get model --global returns global value
        const getGlobal = yield* run(opencode, ["config", "get", "model", "--global"])
        opencode.expectExit(getGlobal, 0)
        expect(getGlobal.stdout.trim()).toBe("test-provider/global-model")

        // config get model (effective) returns project value due to higher precedence
        const getEffective = yield* run(opencode, ["config", "get", "model"])
        opencode.expectExit(getEffective, 0)
        expect(getEffective.stdout.trim()).toBe("test-provider/project-model")
      }),
    60_000,
  )

  cliIt.concurrent(
    "warns on stderr when setting a global key shadowed by project config",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        // Create project config with a specific model
        yield* run(opencode, ["config", "set", "model", "test-provider/project-model", "--project"])

        // Now set a global model - should warn that it is shadowed
        const setGlobal = yield* run(opencode, ["config", "set", "model", "test-provider/shadowed-global", "--global"])
        opencode.expectExit(setGlobal, 0)
        expect(setGlobal.stdout).toContain('set model = "test-provider/shadowed-global"')
        expect(setGlobal.stderr).toContain("shadowed by higher-precedence configuration")

        // Effective config remains project-model
        const getEffective = yield* run(opencode, ["config", "get", "model"])
        opencode.expectExit(getEffective, 0)
        expect(getEffective.stdout.trim()).toBe("test-provider/project-model")
      }),
    60_000,
  )

  cliIt.concurrent(
    "unsets project config and falls back to global config",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        yield* run(opencode, ["config", "set", "model", "test-provider/fallback-global"])
        yield* run(opencode, ["config", "set", "model", "test-provider/project-override", "--project"])

        // Effective is project-override
        const beforeUnset = yield* run(opencode, ["config", "get", "model"])
        opencode.expectExit(beforeUnset, 0)
        expect(beforeUnset.stdout.trim()).toBe("test-provider/project-override")

        // Unset from project
        const unsetResult = yield* run(opencode, ["config", "unset", "model", "--project"])
        opencode.expectExit(unsetResult, 0)
        expect(unsetResult.stdout).toContain("unset model")

        // Effective now falls back to global
        const afterUnset = yield* run(opencode, ["config", "get", "model"])
        opencode.expectExit(afterUnset, 0)
        expect(afterUnset.stdout.trim()).toBe("test-provider/fallback-global")
      }),
    60_000,
  )

  cliIt.concurrent(
    "writes to .opencode/opencode.json if .opencode directory exists",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(home, ".opencode"), { recursive: true }))

        const result = yield* run(opencode, ["config", "set", "default_agent", "custom-agent", "--scope", "project"])
        opencode.expectExit(result, 0)

        const subfolderFile = path.join(home, ".opencode", "opencode.json")
        const exists = yield* Effect.promise(() =>
          fs
            .stat(subfolderFile)
            .then(() => true)
            .catch(() => false),
        )
        expect(exists).toBe(true)

        const content = yield* Effect.promise(() => Bun.file(subfolderFile).json())
        expect(content.default_agent).toBe("custom-agent")
      }),
    60_000,
  )

  cliIt.concurrent(
    "preserves JSONC comments when modifying project configuration",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const jsoncPath = path.join(home, "opencode.jsonc")
        const initialJsonc = `// Main project configuration
{
  // The primary model for this project
  "model": "copilot/gpt-4o"
}
`
        yield* Effect.promise(() => fs.writeFile(jsoncPath, initialJsonc, "utf-8"))

        const setResult = yield* run(opencode, ["config", "set", "small_model", "copilot/gpt-4o-mini", "--project"])
        opencode.expectExit(setResult, 0)

        const updated = yield* Effect.promise(() => fs.readFile(jsoncPath, "utf-8"))
        expect(updated).toContain("// Main project configuration")
        expect(updated).toContain("// The primary model for this project")
        expect(updated).toContain('"small_model": "copilot/gpt-4o-mini"')
      }),
    60_000,
  )

  cliIt.concurrent(
    "supports --json flag for complex values",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const setResult = yield* run(opencode, [
          "config",
          "set",
          "compaction",
          '{"auto":false,"prune":true}',
          "--json",
          "--project",
        ])
        opencode.expectExit(setResult, 0)

        const getResult = yield* run(opencode, ["config", "get", "compaction", "-p"])
        opencode.expectExit(getResult, 0)
        const parsed = JSON.parse(getResult.stdout)
        expect(parsed).toEqual({ auto: false, prune: true })
      }),
    60_000,
  )

  cliIt.concurrent(
    "validates mutually exclusive scope flags",
    ({ opencode }) =>
      Effect.gen(function* () {
        const bothFlags = yield* run(opencode, ["config", "set", "model", "foo", "--project", "--global"])
        expect(bothFlags.exitCode).not.toBe(0)
        expect(bothFlags.stderr).toContain("Cannot specify both --project and --global")

        const scopeAndProject = yield* run(opencode, ["config", "set", "model", "foo", "--scope", "project", "-p"])
        expect(scopeAndProject.exitCode).not.toBe(0)
        expect(scopeAndProject.stderr).toContain("Cannot specify both --scope and --project/--global")
      }),
    60_000,
  )

  cliIt.concurrent(
    "rejects invalid schema values without modifying config file",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        yield* run(opencode, ["config", "set", "model", "initial-model", "-p"])

        const invalidSet = yield* run(opencode, ["config", "set", "model", '{"not":"a-string"}', "--json", "-p"])
        expect(invalidSet.exitCode).not.toBe(0)

        const projectFile = path.join(home, "opencode.json")
        const content = yield* Effect.promise(() => Bun.file(projectFile).json())
        expect(content.model).toBe("initial-model")
      }),
    60_000,
  )

  cliIt.concurrent(
    "lists configuration via list and ls alias with scoping",
    ({ opencode }) =>
      Effect.gen(function* () {
        yield* run(opencode, ["config", "set", "model", "test-provider/global-list-model", "--global"])
        yield* run(opencode, ["config", "set", "small_model", "test-provider/project-small-model", "--project"])

        // Effective config list contains both
        const listEffective = yield* run(opencode, ["config", "list"])
        opencode.expectExit(listEffective, 0)
        const parsedEffective = JSON.parse(listEffective.stdout)
        expect(parsedEffective.model).toBe("test-provider/global-list-model")
        expect(parsedEffective.small_model).toBe("test-provider/project-small-model")

        // Scoped project list via ls alias
        const listProject = yield* run(opencode, ["config", "ls", "-p"])
        opencode.expectExit(listProject, 0)
        const parsedProject = JSON.parse(listProject.stdout)
        expect(parsedProject.small_model).toBe("test-provider/project-small-model")
        expect(parsedProject.model).toBeUndefined()

        // Scoped global list via --global
        const listGlobal = yield* run(opencode, ["config", "list", "--global"])
        opencode.expectExit(listGlobal, 0)
        const parsedGlobal = JSON.parse(listGlobal.stdout)
        expect(parsedGlobal.model).toBe("test-provider/global-list-model")
      }),
    60_000,
  )

  cliIt.concurrent(
    "sets, gets, and verifies default_variant and variant alias",
    ({ opencode }) =>
      Effect.gen(function* () {
        // Initially, config verify displays default_variant: (default)
        const initialVerify = yield* run(opencode, ["config", "verify"])
        opencode.expectExit(initialVerify, 0)
        expect(initialVerify.stderr).toContain("Config OK")
        expect(initialVerify.stdout).toContain("default_variant: (default)")

        // Set default_variant
        const setResult = yield* run(opencode, ["config", "set", "default_variant", "high"])
        opencode.expectExit(setResult, 0)
        expect(setResult.stdout).toContain('set default_variant = "high"')

        // Get default_variant
        const getResult = yield* run(opencode, ["config", "get", "default_variant"])
        opencode.expectExit(getResult, 0)
        expect(getResult.stdout.trim()).toBe("high")

        // config verify reflects default_variant
        const verifyResult = yield* run(opencode, ["config", "verify"])
        opencode.expectExit(verifyResult, 0)
        expect(verifyResult.stdout).toContain("default_variant: high")

        // Unset default_variant
        const unsetResult = yield* run(opencode, ["config", "unset", "default_variant"])
        opencode.expectExit(unsetResult, 0)
        expect(unsetResult.stdout).toContain("unset default_variant")

        // Set via variant alias
        const setAlias = yield* run(opencode, ["config", "set", "variant", "xhigh"])
        opencode.expectExit(setAlias, 0)
        expect(setAlias.stdout).toContain('set variant = "xhigh"')

        const getAlias = yield* run(opencode, ["config", "get", "variant"])
        opencode.expectExit(getAlias, 0)
        expect(getAlias.stdout.trim()).toBe("xhigh")

        const verifyAlias = yield* run(opencode, ["config", "verify"])
        opencode.expectExit(verifyAlias, 0)
        expect(verifyAlias.stdout).toContain("default_variant: xhigh")
      }),
    60_000,
  )

  cliIt.concurrent(
    "resolves config paths via config path subcommand",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        // 1. Path for global config
        const globalPathRes = yield* run(opencode, ["config", "path", "--global"])
        opencode.expectExit(globalPathRes, 0)
        expect(globalPathRes.stdout.trim()).toContain(path.join(home, ".config", "lmplayer"))

        // 2. Path for project config
        const projectPathRes = yield* run(opencode, ["config", "path", "--project"])
        opencode.expectExit(projectPathRes, 0)
        expect(projectPathRes.stdout.trim()).toContain("opencode.json")

        // 3. Path with --json output
        const jsonPathRes = yield* run(opencode, ["config", "path", "--json"])
        opencode.expectExit(jsonPathRes, 0)
        const parsed = JSON.parse(jsonPathRes.stdout)
        expect(parsed.global).toBeDefined()
        expect(parsed.project).toBeDefined()
        expect(Array.isArray(parsed.sources)).toBe(true)
      }),
    60_000,
  )

  cliIt.concurrent(
    "supports --json and --output for config verify, get, list, and path",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        // Set model in global config
        const setRes = yield* run(opencode, ["config", "set", "model", "test-provider/test-model"])
        opencode.expectExit(setRes, 0)

        // 1. config verify --json
        const verifyJsonRes = yield* run(opencode, ["config", "verify", "--json"])
        opencode.expectExit(verifyJsonRes, 0)
        const parsedVerify = JSON.parse(verifyJsonRes.stdout)
        expect(parsedVerify.ok).toBe(true)
        expect(Array.isArray(parsedVerify.sources)).toBe(true)
        expect(parsedVerify.model).toBe("test-provider/test-model")

        // 2. config verify --output
        const verifyOutFile = path.join(home, "verify-report.json")
        const verifyOutRes = yield* run(opencode, ["config", "verify", "--json", "-o", verifyOutFile])
        opencode.expectExit(verifyOutRes, 0)
        const verifyFileContent = JSON.parse(yield* Effect.promise(() => fs.readFile(verifyOutFile, "utf-8")))
        expect(verifyFileContent.ok).toBe(true)
        expect(verifyFileContent.model).toBe("test-provider/test-model")

        // 3. config get --output
        const getOutFile = path.join(home, "model-val.txt")
        const getOutRes = yield* run(opencode, ["config", "get", "model", "-o", getOutFile])
        opencode.expectExit(getOutRes, 0)
        const getFileContent = (yield* Effect.promise(() => fs.readFile(getOutFile, "utf-8"))).trim()
        expect(getFileContent).toBe("test-provider/test-model")

        // 4. config list --output
        const listOutFile = path.join(home, "config-list.json")
        const listOutRes = yield* run(opencode, ["config", "list", "-o", listOutFile])
        opencode.expectExit(listOutRes, 0)
        const listFileContent = JSON.parse(yield* Effect.promise(() => fs.readFile(listOutFile, "utf-8")))
        expect(listFileContent.model).toBe("test-provider/test-model")

        // 5. config path --global --output
        const pathOutFile = path.join(home, "config-path.txt")
        const pathOutRes = yield* run(opencode, ["config", "path", "--global", "-o", pathOutFile])
        opencode.expectExit(pathOutRes, 0)
        const pathFileContent = (yield* Effect.promise(() => fs.readFile(pathOutFile, "utf-8"))).trim()
        expect(pathFileContent).toContain(path.join(home, ".config", "lmplayer"))

        // 6. config path --json --output
        const pathJsonOutFile = path.join(home, "config-path.json")
        const pathJsonOutRes = yield* run(opencode, ["config", "path", "--json", "-o", pathJsonOutFile])
        opencode.expectExit(pathJsonOutRes, 0)
        const pathJsonFileContent = JSON.parse(yield* Effect.promise(() => fs.readFile(pathJsonOutFile, "utf-8")))
        expect(pathJsonFileContent.global).toBeDefined()
        expect(pathJsonFileContent.project).toBeDefined()
        expect(Array.isArray(pathJsonFileContent.sources)).toBe(true)
      }),
    60_000,
  )
})


