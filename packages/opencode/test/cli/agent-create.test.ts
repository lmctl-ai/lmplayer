import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import {
  AgentCreateCommand,
  createAgent,
  AgentCloneCommand,
  cloneAgent,
  AgentListCommand,
  AgentShowCommand,
  AgentDeleteCommand,
  listAgents,
  showAgent,
  deleteAgent,
} from "../../src/cli/cmd/agent"
import { CliError } from "../../src/cli/effect-cmd"
import { InstanceRef } from "../../src/effect/instance-ref"
import { InstanceRuntime } from "../../src/project/instance-runtime"
import { AppRuntime } from "../../src/effect/app-runtime"
import { tmpdir } from "../fixture/fixture"
import yargs, { type Argv } from "yargs"
import fs from "fs/promises"
import path from "path"
import matter from "gray-matter"

describe("AgentCreateCommand builder", () => {
  const getBuilder = () => {
    const builder = AgentCreateCommand.builder as (y: Argv) => Argv<any>
    expect(typeof builder).toBe("function")
    return builder
  }

  test("registers name, prompt, prompt-file, and provision options", () => {
    const parser = getBuilder()(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.name).toBeDefined()
    expect(options.key.prompt).toBeDefined()
    expect(options.key["prompt-file"]).toBeDefined()
    expect(options.key.provision).toBeDefined()
  })

  test("parses non-interactive flags correctly", () => {
    const parser = getBuilder()(yargs())
    const parsed = parser.parseSync([
      "--name",
      "reviewer",
      "--prompt",
      "You are a code reviewer",
      "--mode",
      "subagent",
      "--permissions",
      "read,grep,glob",
      "--provision",
      "read,grep",
    ])
    expect(parsed.name).toBe("reviewer")
    expect(parsed.prompt).toBe("You are a code reviewer")
    expect(parsed.mode).toBe("subagent")
    expect(parsed.permissions).toBe("read,grep,glob")
    expect(parsed.provision).toBe("read,grep")
  })
})

describe("AgentCreateCommand handler (non-interactive prompt bypass)", () => {
  const runHandler = (args: Parameters<typeof createAgent>[0], ctx: any) =>
    createAgent(args).pipe(Effect.provideService(InstanceRef, ctx)) as Effect.Effect<void, CliError, never>

  test("creates agent markdown file with direct --prompt and --name", async () => {
    const tmp = await tmpdir({ git: true })
    const dir = tmp.path
    const ctx = await InstanceRuntime.load({ directory: dir })

    try {
      const handlerEffect = runHandler(
        {
          name: "test-coder",
          prompt: "You are an expert coder.",
          description: "Specialized coding agent",
          mode: "subagent",
          permissions: "read,edit,bash",
          provision: "bash",
        },
        ctx,
      )

      await Effect.runPromise(handlerEffect)

      const agentPath = path.join(dir, ".opencode", "agents", "test-coder.md")
      const content = await fs.readFile(agentPath, "utf-8")
      const parsed = matter(content)

      expect(parsed.content.trim()).toBe("You are an expert coder.")
      expect(parsed.data.description).toBe("Specialized coding agent")
      expect(parsed.data.mode).toBe("subagent")
      expect(parsed.data.provision).toEqual(["bash"])
      expect(parsed.data.permission).toEqual({
        glob: "deny",
        grep: "deny",
        webfetch: "deny",
        task: "deny",
        todowrite: "deny",
        websearch: "deny",
        lsp: "deny",
        skill: "deny",
      })
    } finally {
      await InstanceRuntime.disposeInstance(ctx)
    }
  })

  test("creates agent markdown file from --prompt-file", async () => {
    const tmp = await tmpdir({ git: true })
    const dir = tmp.path
    const ctx = await InstanceRuntime.load({ directory: dir })

    try {
      const promptFile = path.join(dir, "prompt.txt")
      await fs.writeFile(promptFile, "You are a doc writer.\nAlways write clear docs.", "utf-8")

      const handlerEffect = runHandler(
        {
          name: "doc-writer",
          "prompt-file": promptFile,
          mode: "primary",
        },
        ctx,
      )

      await Effect.runPromise(handlerEffect)

      const agentPath = path.join(dir, ".opencode", "agents", "doc-writer.md")
      const content = await fs.readFile(agentPath, "utf-8")
      const parsed = matter(content)

      expect(parsed.content.trim()).toBe("You are a doc writer.\nAlways write clear docs.")
      expect(parsed.data.mode).toBe("primary")
      expect(parsed.data.description).toBe("doc-writer")
    } finally {
      await InstanceRuntime.disposeInstance(ctx)
    }
  })

  test("derives agent name from prompt file basename if --name is omitted", async () => {
    const tmp = await tmpdir({ git: true })
    const dir = tmp.path
    const ctx = await InstanceRuntime.load({ directory: dir })

    try {
      const promptFile = path.join(dir, "security-auditor.txt")
      await fs.writeFile(promptFile, "Audit all code for vulnerabilities.", "utf-8")

      const handlerEffect = runHandler(
        {
          "prompt-file": promptFile,
        },
        ctx,
      )

      await Effect.runPromise(handlerEffect)

      const agentPath = path.join(dir, ".opencode", "agents", "security-auditor.md")
      const content = await fs.readFile(agentPath, "utf-8")
      const parsed = matter(content)

      expect(parsed.content.trim()).toBe("Audit all code for vulnerabilities.")
      expect(parsed.data.mode).toBe("all")
    } finally {
      await InstanceRuntime.disposeInstance(ctx)
    }
  })

  test("fails when both --prompt and --prompt-file are provided", async () => {
    const tmp = await tmpdir({ git: true })
    const dir = tmp.path
    const ctx = await InstanceRuntime.load({ directory: dir })

    try {
      const handlerEffect = runHandler(
        {
          name: "conflict",
          prompt: "prompt a",
          "prompt-file": "prompt.txt",
        },
        ctx,
      )

      const exit = await Effect.runPromiseExit(handlerEffect)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(CliError)
        expect((error as CliError).message).toBe("Cannot provide both --prompt and --prompt-file")
      }
    } finally {
      await InstanceRuntime.disposeInstance(ctx)
    }
  })

  test("fails when target agent file already exists", async () => {
    const tmp = await tmpdir({ git: true })
    const dir = tmp.path
    const ctx = await InstanceRuntime.load({ directory: dir })

    try {
      const agentsDir = path.join(dir, ".opencode", "agents")
      await fs.mkdir(agentsDir, { recursive: true })
      await fs.writeFile(path.join(agentsDir, "duplicate.md"), "existing agent", "utf-8")

      const handlerEffect = runHandler(
        {
          name: "duplicate",
          prompt: "new agent prompt",
        },
        ctx,
      )

      const exit = await Effect.runPromiseExit(handlerEffect)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(CliError)
        expect((error as CliError).message).toContain("Agent file already exists")
      }
    } finally {
      await InstanceRuntime.disposeInstance(ctx)
    }
  })

  test("fails when --prompt is used without --name in non-interactive mode", async () => {
    const tmp = await tmpdir({ git: true })
    const dir = tmp.path
    const ctx = await InstanceRuntime.load({ directory: dir })

    const originalIsTTY = process.stdin.isTTY
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true })

    try {
      const handlerEffect = runHandler(
        {
          prompt: "Prompt without name",
        },
        ctx,
      )

      const exit = await Effect.runPromiseExit(handlerEffect)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(CliError)
        expect((error as CliError).message).toContain("Agent name is required when using --prompt")
      }
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true })
      await InstanceRuntime.disposeInstance(ctx)
    }
  })

  test("fails when prompt file does not exist", async () => {
    const tmp = await tmpdir({ git: true })
    const dir = tmp.path
    const ctx = await InstanceRuntime.load({ directory: dir })

    try {
      const handlerEffect = runHandler(
        {
          "prompt-file": path.join(dir, "nonexistent.txt"),
        },
        ctx,
      )

      const exit = await Effect.runPromiseExit(handlerEffect)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(CliError)
        expect((error as CliError).message).toContain("Failed to read prompt file")
      }
    } finally {
      await InstanceRuntime.disposeInstance(ctx)
    }
  })

  test("writes agent to custom --path and includes model in frontmatter", async () => {
    const tmp = await tmpdir({ git: true })
    const dir = tmp.path
    const ctx = await InstanceRuntime.load({ directory: dir })
    const customDir = path.join(dir, "custom-location")

    try {
      const handlerEffect = runHandler(
        {
          name: "custom-agent",
          prompt: "Custom agent prompt",
          path: customDir,
          model: "openai/gpt-4o",
        },
        ctx,
      )

      await Effect.runPromise(handlerEffect)

      const agentPath = path.join(customDir, "agents", "custom-agent.md")
      const content = await fs.readFile(agentPath, "utf-8")
      const parsed = matter(content)

      expect(parsed.content.trim()).toBe("Custom agent prompt")
      expect(parsed.data.model).toBe("openai/gpt-4o")
    } finally {
      await InstanceRuntime.disposeInstance(ctx)
    }
  })
})

describe("AgentListCommand, AgentShowCommand, AgentDeleteCommand", () => {
  const runList = (args: any, ctx: any) =>
    AppRuntime.runPromise(listAgents(args).pipe(Effect.provideService(InstanceRef, ctx)))

  const runShow = (args: any, ctx: any) =>
    AppRuntime.runPromise(showAgent(args).pipe(Effect.provideService(InstanceRef, ctx)))

  const runShowExit = (args: any, ctx: any) =>
    AppRuntime.runPromiseExit(showAgent(args).pipe(Effect.provideService(InstanceRef, ctx)))

  const runDelete = (args: any, ctx: any) =>
    AppRuntime.runPromise(deleteAgent(args).pipe(Effect.provideService(InstanceRef, ctx)))

  const runDeleteExit = (args: any, ctx: any) =>
    AppRuntime.runPromiseExit(deleteAgent(args).pipe(Effect.provideService(InstanceRef, ctx)))

  test("AgentListCommand registers json and mode options and aliases ls", () => {
    expect(AgentListCommand.aliases).toContain("ls")
    const builder = AgentListCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.json).toBeDefined()
    expect(options.key.mode).toBeDefined()
  })

  test("AgentShowCommand registers name and json options and aliases get", () => {
    expect(AgentShowCommand.aliases).toContain("get")
    const builder = AgentShowCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.json).toBeDefined()
  })

  test("AgentDeleteCommand registers name and json options and aliases rm", () => {
    expect(AgentDeleteCommand.aliases).toContain("rm")
    const builder = AgentDeleteCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.json).toBeDefined()
  })

  test("AgentListCommand lists agents in json format and filters by mode", async () => {
    const tmp = await tmpdir({ git: true })
    const dir = tmp.path
    const ctx = await InstanceRuntime.load({ directory: dir })

    try {
      let captured = ""
      const originalWrite = process.stdout.write
      process.stdout.write = ((chunk: any) => {
        captured += String(chunk)
        return true
      }) as any

      try {
        await runList({ json: true }, ctx)
      } finally {
        process.stdout.write = originalWrite
      }

      const list = JSON.parse(captured)
      expect(Array.isArray(list)).toBe(true)
      expect(list.some((a: any) => a.name === "build")).toBe(true)

      // Test mode filtering
      let primaryCaptured = ""
      process.stdout.write = ((chunk: any) => {
        primaryCaptured += String(chunk)
        return true
      }) as any

      try {
        await runList({ json: true, mode: "primary" }, ctx)
      } finally {
        process.stdout.write = originalWrite
      }

      const primaryList = JSON.parse(primaryCaptured)
      expect(primaryList.every((a: any) => a.mode === "primary" || a.mode === "all")).toBe(true)
    } finally {
      await InstanceRuntime.disposeInstance(ctx)
    }
  })

  test("AgentShowCommand displays agent details and fails for missing agent", async () => {
    const tmp = await tmpdir({ git: true })
    const dir = tmp.path
    const ctx = await InstanceRuntime.load({ directory: dir })

    try {
      let captured = ""
      const originalWrite = process.stdout.write
      process.stdout.write = ((chunk: any) => {
        captured += String(chunk)
        return true
      }) as any

      try {
        await runShow({ name: "build", json: true }, ctx)
      } finally {
        process.stdout.write = originalWrite
      }

      const data = JSON.parse(captured)
      expect(data.name).toBe("build")
      expect(data.mode).toBeDefined()
      expect(data.permission).toBeDefined()

      // Missing agent
      const exit = await runShowExit({ name: "nonexistent-agent", json: true }, ctx)
      expect(Exit.isFailure(exit)).toBe(true)
    } finally {
      await InstanceRuntime.disposeInstance(ctx)
    }
  })

  test("AgentDeleteCommand fails for built-in agents and deletes custom agents", async () => {
    const tmp = await tmpdir({ git: true })
    const dir = tmp.path
    const ctx = await InstanceRuntime.load({ directory: dir })

    try {
      // 1. Built-in agent cannot be deleted
      const exit = await runDeleteExit({ name: "build" }, ctx)
      expect(Exit.isFailure(exit)).toBe(true)

      // 2. Create custom agent
      const createEffect = createAgent({
        name: "temp-agent",
        prompt: "Temporary agent",
        mode: "subagent",
      }).pipe(Effect.provideService(InstanceRef, ctx)) as Effect.Effect<void, CliError, never>
      await Effect.runPromise(createEffect)

      const agentFile = path.join(dir, ".opencode", "agents", "temp-agent.md")
      expect(await fs.stat(agentFile).then(() => true).catch(() => false)).toBe(true)

      // 3. Delete custom agent
      let captured = ""
      const originalWrite = process.stdout.write
      process.stdout.write = ((chunk: any) => {
        captured += String(chunk)
        return true
      }) as any

      try {
        await runDelete({ name: "temp-agent", json: true }, ctx)
      } finally {
        process.stdout.write = originalWrite
      }

      const deleteData = JSON.parse(captured)
      expect(deleteData.name).toBe("temp-agent")
      expect(deleteData.deleted).toBe(true)
      expect(await fs.stat(agentFile).then(() => true).catch(() => false)).toBe(false)
    } finally {
      await InstanceRuntime.disposeInstance(ctx)
    }
  })
})

describe("AgentCloneCommand builder and handler", () => {
  const getBuilder = () => {
    const builder = AgentCloneCommand.builder as (y: Argv) => Argv<any>
    expect(typeof builder).toBe("function")
    return builder
  }

  const runClone = (args: any, ctx: any) =>
    AppRuntime.runPromise(cloneAgent(args).pipe(Effect.provideService(InstanceRef, ctx)))

  const runCloneExit = (args: any, ctx: any) =>
    AppRuntime.runPromiseExit(cloneAgent(args).pipe(Effect.provideService(InstanceRef, ctx)))

  test("registers source and target positionals, options, and aliases copy/cp", () => {
    expect(AgentCloneCommand.aliases).toEqual(["copy", "cp"])
    const parser = getBuilder()(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.path).toBeDefined()
    expect(options.key.scope).toBeDefined()
    expect(options.key.description).toBeDefined()
    expect(options.key.model).toBeDefined()
    expect(options.key.force).toBeDefined()
    expect(options.key.json).toBeDefined()
  })

  test("clones a built-in agent with overrides, preserves prompt, and outputs json", async () => {
    const tmp = await tmpdir({ git: true })
    const dir = tmp.path
    const ctx = await InstanceRuntime.load({ directory: dir })

    try {
      // 1. Fails for non-existent source
      const failExit = await runCloneExit({ source: "non-existent-agent", target: "my-agent" }, ctx)
      expect(Exit.isFailure(failExit)).toBe(true)

      // 2. Fails when trying to overwrite a built-in agent
      const builtinExit = await runCloneExit({ source: "build", target: "plan" }, ctx)
      expect(Exit.isFailure(builtinExit)).toBe(true)

      // 3. Clone built-in agent 'build' to 'custom-builder' with custom description and model
      let captured = ""
      const originalWrite = process.stdout.write
      process.stdout.write = ((chunk: any) => {
        captured += String(chunk)
        return true
      }) as any

      try {
        await runClone(
          {
            source: "build",
            target: "custom-builder",
            description: "My custom build agent",
            model: "anthropic/claude-3-5-sonnet",
            json: true,
          },
          ctx,
        )
      } finally {
        process.stdout.write = originalWrite
      }

      const cloneData = JSON.parse(captured)
      expect(cloneData.source).toBe("build")
      expect(cloneData.target).toBe("custom-builder")
      expect(cloneData.model).toBe("anthropic/claude-3-5-sonnet")

      const targetFile = cloneData.file
      expect(await fs.stat(targetFile).then(() => true).catch(() => false)).toBe(true)

      const fileContent = await fs.readFile(targetFile, "utf-8")
      const parsed = matter(fileContent)
      expect(parsed.data.description).toBe("My custom build agent")
      expect(parsed.data.model).toBe("anthropic/claude-3-5-sonnet")
      expect(parsed.content.length).toBeGreaterThan(0)

      // 4. Cloning again without force fails
      const duplicateExit = await runCloneExit({ source: "build", target: "custom-builder" }, ctx)
      expect(Exit.isFailure(duplicateExit)).toBe(true)

      // 5. Cloning again with force succeeds
      await runClone(
        {
          source: "build",
          target: "custom-builder",
          description: "Overwritten build agent",
          force: true,
        },
        ctx,
      )
      const overwrittenContent = await fs.readFile(targetFile, "utf-8")
      const overwrittenParsed = matter(overwrittenContent)
      expect(overwrittenParsed.data.description).toBe("Overwritten build agent")
    } finally {
      await InstanceRuntime.disposeInstance(ctx)
    }
  })
})
