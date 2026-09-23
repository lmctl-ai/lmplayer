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
  AgentCommand,
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

  test("registers name, prompt, prompt-file, description, permissions, model, provision, and output options and aliases", () => {
    const parser = getBuilder()(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.name).toBeDefined()
    expect(options.key.n).toBeDefined()
    expect(options.key.prompt).toBeDefined()
    expect(options.key.p).toBeDefined()
    expect(options.key["prompt-file"]).toBeDefined()
    expect(options.key.description).toBeDefined()
    expect(options.key.d).toBeDefined()
    expect(options.key.permissions).toBeDefined()
    expect(options.key.tools).toBeDefined()
    expect(options.key.perms).toBeDefined()
    expect(options.key.model).toBeDefined()
    expect(options.key.m).toBeDefined()
    expect(options.key.provision).toBeDefined()
    expect(options.key.json).toBeDefined()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
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

  test("parses short aliases -n, -p, -d, -m, -o, and --perms correctly", () => {
    const parser = getBuilder()(yargs())
    const parsed = parser.parseSync([
      "-n",
      "reviewer-short",
      "-p",
      "Prompt content",
      "-d",
      "Short description",
      "-m",
      "anthropic/claude-sonnet-4-0",
      "--perms",
      "read,grep",
      "-o",
      "agent.md",
      "--json",
    ])
    expect(parsed.name).toBe("reviewer-short")
    expect(parsed.prompt).toBe("Prompt content")
    expect(parsed.description).toBe("Short description")
    expect(parsed.model).toBe("anthropic/claude-sonnet-4-0")
    expect(parsed.permissions).toBe("read,grep")
    expect(parsed.output).toBe("agent.md")
    expect(parsed.json).toBe(true)
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

  test("creates agent with -o output file (text) and --output --json (json)", async () => {
    const tmp = await tmpdir({ git: true })
    const dir = tmp.path
    const ctx = await InstanceRuntime.load({ directory: dir })

    try {
      // 1. Text output
      const textOut = path.join(dir, "create-out.txt")
      await Effect.runPromise(
        runHandler(
          {
            name: "text-agent",
            prompt: "Text agent prompt",
            output: textOut,
          },
          ctx,
        ),
      )
      const textContent = await fs.readFile(textOut, "utf-8")
      expect(textContent).toContain("Agent created:")
      expect(textContent).toContain("text-agent.md")

      // 2. JSON output
      const jsonOut = path.join(dir, "create-out.json")
      await Effect.runPromise(
        runHandler(
          {
            name: "json-agent",
            prompt: "JSON agent prompt",
            model: "anthropic/claude-3-5-sonnet",
            json: true,
            output: jsonOut,
          },
          ctx,
        ),
      )
      const jsonContent = await fs.readFile(jsonOut, "utf-8")
      const parsedJson = JSON.parse(jsonContent)
      expect(parsedJson.name).toBe("json-agent")
      expect(parsedJson.model).toBe("anthropic/claude-3-5-sonnet")
      expect(parsedJson.file).toContain("json-agent.md")
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

  test("AgentListCommand registers json, mode, output, search, and native options and aliases ls", () => {
    expect(AgentListCommand.aliases).toContain("ls")
    const builder = AgentListCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.json).toBeDefined()
    expect(options.key.mode).toBeDefined()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.search).toBeDefined()
    expect(options.key.q).toBeDefined()
    expect(options.key.query).toBeDefined()
    expect(options.key.native).toBeDefined()
  })

  test("AgentListCommand parses options and short aliases -q and -o", async () => {
    const parsed = await yargs().command({ ...AgentListCommand, handler: () => {} }).parseAsync([
      "list",
      "-q",
      "coder",
      "-o",
      "list.json",
      "--mode",
      "primary",
      "--native",
      "--json",
    ])
    expect(parsed.q).toBe("coder")
    expect(parsed.search).toBe("coder")
    expect(parsed.o).toBe("list.json")
    expect(parsed.output).toBe("list.json")
    expect(parsed.mode).toBe("primary")
    expect(parsed.native).toBe(true)
    expect(parsed.json).toBe(true)
  })

  test("AgentShowCommand registers name, json, and output options and aliases get", () => {
    expect(AgentShowCommand.aliases).toContain("get")
    const builder = AgentShowCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.json).toBeDefined()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
  })

  test("AgentShowCommand parses options and short alias -o", async () => {
    const parsed = await yargs().command({ ...AgentShowCommand, handler: () => {} }).parseAsync([
      "show",
      "build",
      "-o",
      "agent.json",
      "--json",
    ])
    expect(parsed.name).toBe("build")
    expect(parsed.o).toBe("agent.json")
    expect(parsed.output).toBe("agent.json")
    expect(parsed.json).toBe(true)
  })

  test("AgentDeleteCommand registers name, force, json, and output options and aliases rm", () => {
    expect(AgentDeleteCommand.aliases).toContain("rm")
    const builder = AgentDeleteCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.json).toBeDefined()
    expect(options.key.force).toBeDefined()
    expect(options.key.f).toBeDefined()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
  })

  test("AgentDeleteCommand parses options and short aliases -f and -o", async () => {
    const parsed = await yargs().command({ ...AgentDeleteCommand, handler: () => {} }).parseAsync([
      "delete",
      "custom-agent",
      "-f",
      "-o",
      "del.json",
      "--json",
    ])
    expect(parsed.name).toBe("custom-agent")
    expect(parsed.f).toBe(true)
    expect(parsed.force).toBe(true)
    expect(parsed.o).toBe("del.json")
    expect(parsed.output).toBe("del.json")
    expect(parsed.json).toBe(true)
  })

  test("AgentListCommand lists agents in json format, filters by mode/search/native, and exports to file", async () => {
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

      // Test search filtering
      let searchCaptured = ""
      process.stdout.write = ((chunk: any) => {
        searchCaptured += String(chunk)
        return true
      }) as any

      try {
        await runList({ json: true, search: "build" }, ctx)
      } finally {
        process.stdout.write = originalWrite
      }

      const searchList = JSON.parse(searchCaptured)
      expect(searchList.some((a: any) => a.name === "build")).toBe(true)

      // Test native filtering
      let nativeCaptured = ""
      process.stdout.write = ((chunk: any) => {
        nativeCaptured += String(chunk)
        return true
      }) as any

      try {
        await runList({ json: true, native: true }, ctx)
      } finally {
        process.stdout.write = originalWrite
      }

      const nativeList = JSON.parse(nativeCaptured)
      expect(nativeList.every((a: any) => a.native === true)).toBe(true)

      // Test output file export (json)
      const outFile = path.join(dir, "agents.json")
      await runList({ json: true, output: outFile }, ctx)
      const exportedJson = JSON.parse(await fs.readFile(outFile, "utf-8"))
      expect(Array.isArray(exportedJson)).toBe(true)

      // Test output file export (text)
      const outTextFile = path.join(dir, "agents.txt")
      await runList({ output: outTextFile }, ctx)
      const exportedText = await fs.readFile(outTextFile, "utf-8")
      expect(exportedText).toContain("build")
    } finally {
      await InstanceRuntime.disposeInstance(ctx)
    }
  })

  test("AgentShowCommand displays agent details, exports to file, and fails for missing agent", async () => {
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

      // Test output file export
      const showOutFile = path.join(dir, "build-agent.json")
      await runShow({ name: "build", json: true, output: showOutFile }, ctx)
      const exportedShow = JSON.parse(await fs.readFile(showOutFile, "utf-8"))
      expect(exportedShow.name).toBe("build")

      // Missing agent
      const exit = await runShowExit({ name: "nonexistent-agent", json: true }, ctx)
      expect(Exit.isFailure(exit)).toBe(true)
    } finally {
      await InstanceRuntime.disposeInstance(ctx)
    }
  })

  test("AgentDeleteCommand fails for built-in agents, handles force option, and deletes custom agents", async () => {
    const tmp = await tmpdir({ git: true })
    const dir = tmp.path
    const ctx = await InstanceRuntime.load({ directory: dir })

    try {
      // 1. Built-in agent cannot be deleted
      const exit = await runDeleteExit({ name: "build" }, ctx)
      expect(Exit.isFailure(exit)).toBe(true)

      // 2. Force delete on nonexistent agent succeeds cleanly
      let forceCaptured = ""
      const originalWrite = process.stdout.write
      process.stdout.write = ((chunk: any) => {
        forceCaptured += String(chunk)
        return true
      }) as any

      try {
        await runDelete({ name: "nonexistent-agent", force: true, json: true }, ctx)
      } finally {
        process.stdout.write = originalWrite
      }

      const forceData = JSON.parse(forceCaptured)
      expect(forceData.deleted).toBe(false)
      expect(forceData.name).toBe("nonexistent-agent")

      // 3. Create custom agent
      const createEffect = createAgent({
        name: "temp-agent",
        prompt: "Temporary agent",
        mode: "subagent",
      }).pipe(Effect.provideService(InstanceRef, ctx)) as Effect.Effect<void, CliError, never>
      await Effect.runPromise(createEffect)

      const agentFile = path.join(dir, ".opencode", "agents", "temp-agent.md")
      expect(await fs.stat(agentFile).then(() => true).catch(() => false)).toBe(true)

      // 4. Delete custom agent with output file
      const deleteOutFile = path.join(dir, "delete-result.json")
      let captured = ""
      process.stdout.write = ((chunk: any) => {
        captured += String(chunk)
        return true
      }) as any

      try {
        await runDelete({ name: "temp-agent", json: true, output: deleteOutFile }, ctx)
      } finally {
        process.stdout.write = originalWrite
      }

      const deleteData = JSON.parse(captured)
      expect(deleteData.name).toBe("temp-agent")
      expect(deleteData.deleted).toBe(true)
      expect(await fs.stat(agentFile).then(() => true).catch(() => false)).toBe(false)

      const deleteFileContent = JSON.parse(await fs.readFile(deleteOutFile, "utf-8"))
      expect(deleteFileContent.name).toBe("temp-agent")
      expect(deleteFileContent.deleted).toBe(true)
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
    expect(options.key.s).toBeDefined()
    expect(options.key.description).toBeDefined()
    expect(options.key.d).toBeDefined()
    expect(options.key.model).toBeDefined()
    expect(options.key.m).toBeDefined()
    expect(options.key.force).toBeDefined()
    expect(options.key.f).toBeDefined()
    expect(options.key.json).toBeDefined()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
  })

  test("AgentCloneCommand parses short aliases -s, -d, -m, -f, -o", async () => {
    const parsed = await yargs().command({ ...AgentCloneCommand, handler: () => {} }).parseAsync([
      "clone",
      "build",
      "my-custom-agent",
      "-s",
      "global",
      "-d",
      "Cloned builder",
      "-m",
      "openai/gpt-5.4",
      "-f",
      "-o",
      "clone.json",
      "--json",
    ])
    expect(parsed.source).toBe("build")
    expect(parsed.target).toBe("my-custom-agent")
    expect(parsed.s).toBe("global")
    expect(parsed.scope).toBe("global")
    expect(parsed.d).toBe("Cloned builder")
    expect(parsed.description).toBe("Cloned builder")
    expect(parsed.m).toBe("openai/gpt-5.4")
    expect(parsed.model).toBe("openai/gpt-5.4")
    expect(parsed.f).toBe(true)
    expect(parsed.force).toBe(true)
    expect(parsed.o).toBe("clone.json")
    expect(parsed.output).toBe("clone.json")
    expect(parsed.json).toBe(true)
  })

  test("AgentCommand registers create, clone, list, show, and delete subcommands", async () => {
    expect(AgentCommand.command).toBe("agent")
    const executed = { command: "" }
    const customAgent = {
      ...AgentCommand,
      builder: (y: Argv) =>
        y
          .command({ ...AgentCreateCommand, handler: () => { executed.command = "create" } })
          .command({ ...AgentCloneCommand, handler: () => { executed.command = "clone" } })
          .command({ ...AgentListCommand, handler: () => { executed.command = "list" } })
          .command({ ...AgentShowCommand, handler: () => { executed.command = "show" } })
          .command({ ...AgentDeleteCommand, handler: () => { executed.command = "delete" } })
          .demandCommand(),
    }
    const app = yargs().command(customAgent)
    await app.parseAsync(["agent", "list", "--json"])
    expect(executed.command).toBe("list")
    await app.parseAsync(["agent", "show", "build"])
    expect(executed.command).toBe("show")
    await app.parseAsync(["agent", "delete", "custom-agent", "-f"])
    expect(executed.command).toBe("delete")
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

      // 6. Cloning with -o output file writes human text summary
      const textOutFile = path.join(dir, "clone-result.txt")
      await runClone(
        {
          source: "build",
          target: "agent-text-out",
          output: textOutFile,
        },
        ctx,
      )
      const textContent = await fs.readFile(textOutFile, "utf-8")
      expect(textContent).toContain('Agent "build" cloned to "agent-text-out"')

      // 7. Cloning with --output and --json writes JSON summary
      const jsonOutFile = path.join(dir, "clone-result.json")
      await runClone(
        {
          source: "build",
          target: "agent-json-out",
          json: true,
          output: jsonOutFile,
        },
        ctx,
      )
      const jsonContent = await fs.readFile(jsonOutFile, "utf-8")
      const parsedCloneJson = JSON.parse(jsonContent)
      expect(parsedCloneJson.source).toBe("build")
      expect(parsedCloneJson.target).toBe("agent-json-out")
      expect(parsedCloneJson.file).toContain("agent-json-out.md")
    } finally {
      await InstanceRuntime.disposeInstance(ctx)
    }
  })
})
