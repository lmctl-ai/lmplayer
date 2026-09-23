import { test, expect, describe } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import {
  extractResponseText,
  formatPromptTooLargeError,
  generateWorkflowYaml,
  buildGithubInstallResult,
  formatGithubInstallText,
  buildNextSteps,
  getProviderEnv,
  getDefaultModel,
  writeOutputFile,
  WORKFLOW_FILE,
  GithubRunCommand,
  GithubInstallCommand,
  GithubCommand,
} from "../../src/cli/cmd/github"
import yargs, { type Argv } from "yargs"
import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"
import type { MessageV2 } from "../../src/session/message-v2"
import { SessionID, MessageID, PartID } from "../../src/session/schema"

// Helper to create minimal valid parts
function createTextPart(text: string): SessionV1.Part {
  return {
    id: PartID.ascending(),
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make("msg_test"),
    type: "text" as const,
    text,
  }
}

function createReasoningPart(text: string): SessionV1.Part {
  return {
    id: PartID.ascending(),
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make("msg_test"),
    type: "reasoning" as const,
    text,
    time: { start: 0 },
  }
}

function createToolPart(tool: string, title: string, status: "completed" | "running" = "completed"): SessionV1.Part {
  if (status === "completed") {
    return {
      id: PartID.ascending(),
      sessionID: SessionID.make("ses_test"),
      messageID: MessageID.make("msg_test"),
      type: "tool" as const,
      callID: "c1",
      tool,
      state: {
        status: "completed",
        input: {},
        output: "",
        title,
        metadata: {},
        time: { start: 0, end: 1 },
      },
    }
  }
  return {
    id: PartID.ascending(),
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make("msg_test"),
    type: "tool" as const,
    callID: "c1",
    tool,
    state: {
      status: "running",
      input: {},
      time: { start: 0 },
    },
  }
}

function createStepStartPart(): SessionV1.Part {
  return {
    id: PartID.ascending(),
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make("msg_test"),
    type: "step-start" as const,
  }
}

function createStepFinishPart(): SessionV1.Part {
  return {
    id: PartID.ascending(),
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make("msg_test"),
    type: "step-finish" as const,
    reason: "done",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

describe("extractResponseText", () => {
  test("returns text from text part", () => {
    const parts = [createTextPart("Hello world")]
    expect(extractResponseText(parts)).toBe("Hello world")
  })

  test("returns last text part when multiple exist", () => {
    const parts = [createTextPart("First"), createTextPart("Last")]
    expect(extractResponseText(parts)).toBe("Last")
  })

  test("returns text even when tool parts follow", () => {
    const parts = [createTextPart("I'll help with that."), createToolPart("todowrite", "3 todos")]
    expect(extractResponseText(parts)).toBe("I'll help with that.")
  })

  test("returns null for reasoning-only response (signals summary needed)", () => {
    const parts = [createReasoningPart("Let me think about this...")]
    expect(extractResponseText(parts)).toBeNull()
  })

  test("returns null for tool-only response (signals summary needed)", () => {
    // This is the exact scenario from the bug report - todowrite with no text
    const parts = [createToolPart("todowrite", "8 todos")]
    expect(extractResponseText(parts)).toBeNull()
  })

  test("returns null for multiple completed tools", () => {
    const parts = [
      createToolPart("read", "src/file.ts"),
      createToolPart("edit", "src/file.ts"),
      createToolPart("bash", "bun test"),
    ]
    expect(extractResponseText(parts)).toBeNull()
  })

  test("returns null for running tool parts (signals summary needed)", () => {
    const parts = [createToolPart("bash", "", "running")]
    expect(extractResponseText(parts)).toBeNull()
  })

  test("throws on empty array", () => {
    expect(() => extractResponseText([])).toThrow("no parts returned")
  })

  test("returns null for step-start only", () => {
    const parts = [createStepStartPart()]
    expect(extractResponseText(parts)).toBeNull()
  })

  test("returns null for step-finish only", () => {
    const parts = [createStepFinishPart()]
    expect(extractResponseText(parts)).toBeNull()
  })

  test("returns null for step-start and step-finish", () => {
    const parts = [createStepStartPart(), createStepFinishPart()]
    expect(extractResponseText(parts)).toBeNull()
  })

  test("returns text from multi-step response", () => {
    const parts = [
      createStepStartPart(),
      createToolPart("read", "src/file.ts"),
      createTextPart("Done"),
      createStepFinishPart(),
    ]
    expect(extractResponseText(parts)).toBe("Done")
  })

  test("prefers text over reasoning when both present", () => {
    const parts = [createReasoningPart("Internal thinking..."), createTextPart("Final answer")]
    expect(extractResponseText(parts)).toBe("Final answer")
  })

  test("prefers text over tools when both present", () => {
    const parts = [createToolPart("read", "src/file.ts"), createTextPart("Here's what I found")]
    expect(extractResponseText(parts)).toBe("Here's what I found")
  })
})

describe("formatPromptTooLargeError", () => {
  test("formats error without files", () => {
    const result = formatPromptTooLargeError([])
    expect(result).toBe("PROMPT_TOO_LARGE: The prompt exceeds the model's context limit.")
  })

  test("formats error with files (base64 content)", () => {
    // Base64 is ~33% larger than original, so we multiply by 0.75 to get original size
    // 400 KB base64 = 300 KB original, 200 KB base64 = 150 KB original
    const files = [
      { filename: "screenshot.png", content: "a".repeat(400 * 1024) },
      { filename: "diagram.png", content: "b".repeat(200 * 1024) },
    ]
    const result = formatPromptTooLargeError(files)

    expect(result).toStartWith("PROMPT_TOO_LARGE: The prompt exceeds the model's context limit.")
    expect(result).toInclude("Files in prompt:")
    expect(result).toInclude("screenshot.png (300 KB)")
    expect(result).toInclude("diagram.png (150 KB)")
  })

  test("lists all files when multiple present", () => {
    // Base64 sizes: 4KB -> 3KB, 8KB -> 6KB, 12KB -> 9KB
    const files = [
      { filename: "img1.png", content: "x".repeat(4 * 1024) },
      { filename: "img2.jpg", content: "y".repeat(8 * 1024) },
      { filename: "img3.gif", content: "z".repeat(12 * 1024) },
    ]
    const result = formatPromptTooLargeError(files)

    expect(result).toInclude("img1.png (3 KB)")
    expect(result).toInclude("img2.jpg (6 KB)")
    expect(result).toInclude("img3.gif (9 KB)")
  })
})

describe("generateWorkflowYaml", () => {
  test("generates workflow with standard provider and single secret", () => {
    const yaml = generateWorkflowYaml({
      provider: "anthropic",
      model: "claude-sonnet-4-0",
      envVars: ["ANTHROPIC_API_KEY"],
    })

    expect(yaml).toInclude("name: opencode")
    expect(yaml).toInclude("uses: actions/checkout@v6")
    expect(yaml).toInclude("uses: anomalyco/opencode/github@latest")
    expect(yaml).toInclude("env:\n          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}")
    expect(yaml).toInclude("model: anthropic/claude-sonnet-4-0")
  })

  test("generates workflow with multiple env secrets", () => {
    const yaml = generateWorkflowYaml({
      provider: "custom",
      model: "my-model",
      envVars: ["API_KEY", "API_BASE_URL"],
    })

    expect(yaml).toInclude("API_KEY: ${{ secrets.API_KEY }}")
    expect(yaml).toInclude("API_BASE_URL: ${{ secrets.API_BASE_URL }}")
    expect(yaml).toInclude("model: custom/my-model")
  })

  test("omits env block for amazon-bedrock (AWS OIDC authentication)", () => {
    const yaml = generateWorkflowYaml({
      provider: "amazon-bedrock",
      model: "anthropic.claude-v3-sonnet",
      envVars: ["AWS_ACCESS_KEY_ID"],
    })

    expect(yaml).not.toInclude("env:")
    expect(yaml).not.toInclude("secrets.AWS_ACCESS_KEY_ID")
    expect(yaml).toInclude("model: amazon-bedrock/anthropic.claude-v3-sonnet")
  })

  test("does not double provider prefix if model already contains slash", () => {
    const yaml = generateWorkflowYaml({
      provider: "openai",
      model: "openai/gpt-5.4",
      envVars: ["OPENAI_API_KEY"],
    })

    expect(yaml).toInclude("model: openai/gpt-5.4")
    expect(yaml).not.toInclude("model: openai/openai/gpt-5.4")
  })

  test("omits env block when envVars is empty", () => {
    const yaml = generateWorkflowYaml({
      provider: "opencode",
      model: "claude-sonnet-4-0",
      envVars: [],
    })

    expect(yaml).not.toInclude("env:")
    expect(yaml).toInclude("model: opencode/claude-sonnet-4-0")
  })
})

describe("getProviderEnv & getDefaultModel", () => {
  test("resolves default env for known providers", () => {
    expect(getProviderEnv("anthropic")).toEqual(["ANTHROPIC_API_KEY"])
    expect(getProviderEnv("openai")).toEqual(["OPENAI_API_KEY"])
    expect(getProviderEnv("google")).toEqual(["GEMINI_API_KEY"])
    expect(getProviderEnv("deepseek")).toEqual(["DEEPSEEK_API_KEY"])
    expect(getProviderEnv("amazon-bedrock")).toEqual([])
    expect(getProviderEnv("unknown-provider")).toEqual([])
  })

  test("uses catalog provider env when provided", () => {
    const catalog = {
      myprov: { env: ["CUSTOM_TOKEN", "CUSTOM_ORG"] },
    }
    expect(getProviderEnv("myprov", catalog)).toEqual(["CUSTOM_TOKEN", "CUSTOM_ORG"])
  })

  test("resolves default models", () => {
    expect(getDefaultModel("opencode")).toBe("claude-sonnet-4-0")
    expect(getDefaultModel("openai")).toBe("gpt-5.4")
    expect(getDefaultModel("anthropic")).toBe("claude-sonnet-4-0")
    expect(getDefaultModel("amazon-bedrock")).toBe("anthropic.claude-v3-sonnet")
    expect(getDefaultModel("unknown")).toBe("default")

    const catalog = {
      myprov: {
        models: {
          "custom-flagship": { id: "custom-flagship", name: "Flagship" },
        },
      },
    }
    expect(getDefaultModel("myprov", catalog)).toBe("custom-flagship")
  })
})

describe("buildNextSteps", () => {
  test("builds next steps for standard provider", () => {
    const steps = buildNextSteps({
      workflowFile: WORKFLOW_FILE,
      provider: "openai",
      owner: "myorg",
      repo: "myrepo",
      secrets: ["OPENAI_API_KEY"],
    })

    expect(steps[0]).toBe("Commit the `.github/workflows/opencode.yml` file and push")
    expect(steps[1]).toBe("Add the following secrets in org or repo (myorg/myrepo) settings: OPENAI_API_KEY")
    expect(steps[2]).toInclude("/oc summarize")
  })

  test("builds next steps for amazon-bedrock OIDC", () => {
    const steps = buildNextSteps({
      workflowFile: WORKFLOW_FILE,
      provider: "amazon-bedrock",
    })

    expect(steps[0]).toBe("Commit the `.github/workflows/opencode.yml` file and push")
    expect(steps[1]).toInclude("Configure OIDC in AWS")
  })
})

describe("buildGithubInstallResult & formatGithubInstallText", () => {
  test("builds structured install result", () => {
    const result = buildGithubInstallResult({
      workflowFile: WORKFLOW_FILE,
      workflowPath: "/path/to/repo/.github/workflows/opencode.yml",
      provider: "anthropic",
      model: "claude-sonnet-4-0",
      written: true,
      secrets: ["ANTHROPIC_API_KEY"],
      nextSteps: ["Step 1", "Step 2"],
    })

    expect(result.workflowFile).toBe(".github/workflows/opencode.yml")
    expect(result.workflowPath).toBe("/path/to/repo/.github/workflows/opencode.yml")
    expect(result.provider).toBe("anthropic")
    expect(result.model).toBe("claude-sonnet-4-0")
    expect(result.written).toBe(true)
    expect(result.dryRun).toBeUndefined()
    expect(result.secrets).toEqual(["ANTHROPIC_API_KEY"])
    expect(result.nextSteps).toEqual(["Step 1", "Step 2"])
  })

  test("builds dry-run result", () => {
    const result = buildGithubInstallResult({
      workflowFile: WORKFLOW_FILE,
      workflowPath: "/path/to/repo/.github/workflows/opencode.yml",
      provider: "openai",
      model: "gpt-5.4",
      written: false,
      dryRun: true,
      secrets: ["OPENAI_API_KEY"],
      content: "name: opencode...",
    })

    expect(result.written).toBe(false)
    expect(result.dryRun).toBe(true)
    expect(result.content).toBe("name: opencode...")

    const formatted = formatGithubInstallText(result)
    expect(formatted[0]).toBe("[dry-run] Would generate GitHub agent workflow: .github/workflows/opencode.yml")
    expect(formatted).toContain("Provider: openai")
    expect(formatted).toContain("Model: gpt-5.4")
    expect(formatted).toContain("Required secrets: OPENAI_API_KEY")
  })

  test("formats text with next steps", () => {
    const result = buildGithubInstallResult({
      workflowFile: WORKFLOW_FILE,
      workflowPath: "/path/.github/workflows/opencode.yml",
      provider: "google",
      model: "gemini-2.5-pro",
      written: true,
      secrets: ["GEMINI_API_KEY"],
      nextSteps: ["Commit file", "Add secret"],
    })

    const lines = formatGithubInstallText(result)
    expect(lines[0]).toBe('Added workflow file: ".github/workflows/opencode.yml"')
    expect(lines).toContain("    1. Commit file")
    expect(lines).toContain("    2. Add secret")
  })
})

describe("writeOutputFile", () => {
  test("writes content and creates intermediate directories", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-install-test-"))
    try {
      const targetFile = path.join(tempDir, "sub", "dir", "workflow.yml")
      const resolved = await writeOutputFile(targetFile, "content: test")
      expect(resolved).toBe(targetFile)

      const read = await fs.readFile(targetFile, "utf-8")
      expect(read).toBe("content: test")
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })
})

describe("github command options and builders", () => {
  test("GithubRunCommand registers output, o, json, event, e, token, and t options", () => {
    const builder = GithubRunCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
    expect(options.key.event).toBeDefined()
    expect(options.key.e).toBeDefined()
    expect(options.key.token).toBeDefined()
    expect(options.key.t).toBeDefined()
  })

  test("GithubInstallCommand registers output, o, json, provider, p, model, m, force, f, dry-run, and skip-app options", () => {
    const builder = GithubInstallCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
    expect(options.key.provider).toBeDefined()
    expect(options.key.p).toBeDefined()
    expect(options.key.model).toBeDefined()
    expect(options.key.m).toBeDefined()
    expect(options.key["dry-run"]).toBeDefined()
    expect(options.key["skip-app"]).toBeDefined()
    expect(options.key.force).toBeDefined()
    expect(options.key.f).toBeDefined()
  })

  test("GithubRunCommand parses options from arguments", async () => {
    const builder = GithubRunCommand.builder as (y: Argv) => Argv<any>
    const parsed = await builder(yargs()).parseAsync([
      "--event",
      '{"action":"test"}',
      "--token",
      "ghp_test123",
      "--output",
      "summary.json",
      "--json",
    ])
    expect(parsed.event).toBe('{"action":"test"}')
    expect(parsed.token).toBe("ghp_test123")
    expect(parsed.output).toBe("summary.json")
    expect(parsed.json).toBe(true)
  })

  test("GithubRunCommand parses short aliases -e, -t, -o", async () => {
    const builder = GithubRunCommand.builder as (y: Argv) => Argv<any>
    const parsed = await builder(yargs()).parseAsync([
      "-e",
      '{"action":"run"}',
      "-t",
      "ghp_shorttoken",
      "-o",
      "run.log",
    ])
    expect(parsed.event).toBe('{"action":"run"}')
    expect(parsed.token).toBe("ghp_shorttoken")
    expect(parsed.output).toBe("run.log")
  })

  test("GithubInstallCommand parses options from arguments", async () => {
    const builder = GithubInstallCommand.builder as (y: Argv) => Argv<any>
    const parsed = await builder(yargs()).parseAsync([
      "--provider",
      "anthropic",
      "--model",
      "claude-sonnet-4-0",
      "--output",
      "custom-workflow.yml",
      "--dry-run",
      "--skip-app",
      "--force",
      "--json",
    ])
    expect(parsed.provider).toBe("anthropic")
    expect(parsed.model).toBe("claude-sonnet-4-0")
    expect(parsed.output).toBe("custom-workflow.yml")
    expect(parsed["dry-run"]).toBe(true)
    expect(parsed["skip-app"]).toBe(true)
    expect(parsed.force).toBe(true)
    expect(parsed.json).toBe(true)
  })

  test("GithubInstallCommand parses short aliases -p, -m, -o, -f", async () => {
    const builder = GithubInstallCommand.builder as (y: Argv) => Argv<any>
    const parsed = await builder(yargs()).parseAsync([
      "-p",
      "openai",
      "-m",
      "gpt-5.4",
      "-o",
      "out.json",
      "-f",
    ])
    expect(parsed.provider).toBe("openai")
    expect(parsed.model).toBe("gpt-5.4")
    expect(parsed.output).toBe("out.json")
    expect(parsed.force).toBe(true)
  })

  test("GithubCommand registers install and run subcommands", async () => {
    expect(GithubCommand.command).toBe("github")
    const executed = { command: "" }
    const customGithub = {
      ...GithubCommand,
      builder: (y: Argv) =>
        y
          .command({ ...GithubInstallCommand, handler: () => { executed.command = "install" } })
          .command({ ...GithubRunCommand, handler: () => { executed.command = "run" } })
          .demandCommand(),
    }
    const app = yargs().command(customGithub)
    await app.parseAsync(["github", "install", "--dry-run"])
    expect(executed.command).toBe("install")
    await app.parseAsync(["github", "run", "-e", "{}"])
    expect(executed.command).toBe("run")
  })
})

