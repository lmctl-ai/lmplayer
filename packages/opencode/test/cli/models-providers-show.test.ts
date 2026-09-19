import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { ModelsShowCommand, modelsShow } from "../../src/cli/cmd/models"
import { ProvidersShowCommand, providersShow } from "../../src/cli/cmd/providers"
import { InstanceRef } from "../../src/effect/instance-ref"
import { InstanceRuntime } from "../../src/project/instance-runtime"
import { AppRuntime } from "../../src/effect/app-runtime"
import { tmpdir } from "../fixture/fixture"
import yargs, { type Argv } from "yargs"

describe("ModelsShowCommand and ProvidersShowCommand builders", () => {
  test("ModelsShowCommand registers show <model>, alias get, and json option", () => {
    expect(ModelsShowCommand.command).toBe("show <model>")
    expect(ModelsShowCommand.aliases).toContain("get")
    const builder = ModelsShowCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.json).toBeDefined()
    expect(options.boolean).toContain("json")
  })

  test("ProvidersShowCommand registers show <provider>, alias get, and json option", () => {
    expect(ProvidersShowCommand.command).toBe("show <provider>")
    expect(ProvidersShowCommand.aliases).toContain("get")
    const builder = ProvidersShowCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.json).toBeDefined()
    expect(options.boolean).toContain("json")
  })
})

describe("providersShow in-process handler", () => {
  const runProvidersShow = (args: any, ctx: any) =>
    AppRuntime.runPromise(providersShow(args).pipe(Effect.provideService(InstanceRef, ctx)))

  const runProvidersShowExit = (args: any, ctx: any) =>
    AppRuntime.runPromiseExit(providersShow(args).pipe(Effect.provideService(InstanceRef, ctx)))

  test("fails cleanly for unknown provider", async () => {
    const tmp = await tmpdir({ git: true })
    const ctx = await InstanceRuntime.load({ directory: tmp.path })
    try {
      const exit = await runProvidersShowExit({ provider: "totally-unknown-xyz-999" }, ctx)
      expect(Exit.isFailure(exit)).toBe(true)
    } finally {
      await InstanceRuntime.disposeInstance(ctx)
    }
  })

  test("outputs detailed json for ollama provider", async () => {
    const tmp = await tmpdir({ git: true })
    const ctx = await InstanceRuntime.load({ directory: tmp.path })
    let captured = ""
    const originalWrite = process.stdout.write
    process.stdout.write = ((chunk: any) => {
      captured += String(chunk)
      return true
    }) as any

    try {
      await runProvidersShow({ provider: "ollama", json: true }, ctx)
      const data = JSON.parse(captured)
      expect(data.id).toBe("ollama")
      expect(data.authenticated).toBe(true)
      expect(data.status).toBe("enabled")
      expect(Array.isArray(data.models)).toBe(true)
      expect(data.auth_source).toBe("local")
    } finally {
      process.stdout.write = originalWrite
      await InstanceRuntime.disposeInstance(ctx)
    }
  })

  test("shows unauthenticated catalog provider with json", async () => {
    const tmp = await tmpdir({ git: true })
    const ctx = await InstanceRuntime.load({ directory: tmp.path })
    let captured = ""
    const originalWrite = process.stdout.write
    process.stdout.write = ((chunk: any) => {
      captured += String(chunk)
      return true
    }) as any

    try {
      await runProvidersShow({ provider: "anthropic", json: true }, ctx)
      const data = JSON.parse(captured)
      expect(data.id).toBe("anthropic")
      expect(data.name).toBe("Anthropic")
      expect(data.status).toBe("enabled")
      expect(typeof data.authenticated).toBe("boolean")
    } finally {
      process.stdout.write = originalWrite
      await InstanceRuntime.disposeInstance(ctx)
    }
  })
})

describe("modelsShow in-process handler", () => {
  const runModelsShow = (args: any, ctx: any) =>
    AppRuntime.runPromise(modelsShow(args).pipe(Effect.provideService(InstanceRef, ctx)))

  const runModelsShowExit = (args: any, ctx: any) =>
    AppRuntime.runPromiseExit(modelsShow(args).pipe(Effect.provideService(InstanceRef, ctx)))

  test("fails cleanly for malformed model format", async () => {
    const tmp = await tmpdir({ git: true })
    const ctx = await InstanceRuntime.load({ directory: tmp.path })
    try {
      const exit = await runModelsShowExit({ model: "/invalid-slash" }, ctx)
      expect(Exit.isFailure(exit)).toBe(true)
    } finally {
      await InstanceRuntime.disposeInstance(ctx)
    }
  })

  test("fails cleanly for unknown model", async () => {
    const tmp = await tmpdir({ git: true })
    const ctx = await InstanceRuntime.load({ directory: tmp.path })
    try {
      const exit = await runModelsShowExit({ model: "nonexistent-model-abcxyz-999" }, ctx)
      expect(Exit.isFailure(exit)).toBe(true)
    } finally {
      await InstanceRuntime.disposeInstance(ctx)
    }
  })

  test("shows detailed json for ollama model", async () => {
    const tmp = await tmpdir({ git: true })
    const ctx = await InstanceRuntime.load({ directory: tmp.path })
    let captured = ""
    const originalWrite = process.stdout.write
    process.stdout.write = ((chunk: any) => {
      captured += String(chunk)
      return true
    }) as any

    try {
      await runModelsShow({ model: "ollama/qwen2.5:7b", json: true }, ctx)
      const data = JSON.parse(captured)
      expect(data.id).toBe("ollama/qwen2.5:7b")
      expect(data.provider.id).toBe("ollama")
      expect(data.available).toBe(true)
      expect(typeof data.capabilities).toBe("object")
      expect(typeof data.limit).toBe("object")
      expect(Array.isArray(data.variants)).toBe(true)
    } finally {
      process.stdout.write = originalWrite
      await InstanceRuntime.disposeInstance(ctx)
    }
  })
})
