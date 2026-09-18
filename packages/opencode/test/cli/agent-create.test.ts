import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { AgentCreateCommand, createAgent } from "../../src/cli/cmd/agent"
import { CliError } from "../../src/cli/effect-cmd"
import { InstanceRef } from "../../src/effect/instance-ref"
import { InstanceRuntime } from "../../src/project/instance-runtime"
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
