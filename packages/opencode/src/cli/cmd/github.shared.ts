import type { SessionV1 } from "@opencode-ai/core/v1/session"
import path from "node:path"
import fs from "node:fs/promises"

export { parseGitHubRemote } from "@/util/repository"

export const WORKFLOW_FILE = ".github/workflows/opencode.yml"

/**
 * Extracts displayable text from assistant response parts.
 * Returns null for non-text responses (signals summary needed).
 * Throws only for truly empty responses.
 */
export function extractResponseText(parts: SessionV1.Part[]): string | null {
  const textPart = parts.findLast((p) => p.type === "text")
  if (textPart) return textPart.text

  // Non-text parts (tools, reasoning, step-start/step-finish, etc.) - signal summary needed
  if (parts.length > 0) return null

  throw new Error("Failed to parse response: no parts returned")
}

/**
 * Formats a PROMPT_TOO_LARGE error message with details about files in the prompt.
 * Content is base64 encoded, so we calculate original size by multiplying by 0.75.
 */
export function formatPromptTooLargeError(files: { filename: string; content: string }[]): string {
  const fileDetails =
    files.length > 0
      ? `\n\nFiles in prompt:\n${files.map((f) => `  - ${f.filename} (${((f.content.length * 0.75) / 1024).toFixed(0)} KB)`).join("\n")}`
      : ""
  return `PROMPT_TOO_LARGE: The prompt exceeds the model's context limit.${fileDetails}`
}

export interface GenerateWorkflowOptions {
  provider: string
  model: string
  envVars?: string[]
}

/**
 * Generates the GitHub Actions workflow YAML for opencode agent.
 */
export function generateWorkflowYaml(opts: GenerateWorkflowOptions): string {
  const isBedrock = opts.provider === "amazon-bedrock"
  const envVars = isBedrock ? [] : (opts.envVars ?? [])
  const envStr =
    envVars.length === 0
      ? ""
      : `\n        env:${envVars.map((e) => `\n          ${e}: \${{ secrets.${e} }}`).join("")}`

  const fullModel = opts.model.includes("/") ? opts.model : `${opts.provider}/${opts.model}`

  return `name: opencode

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

jobs:
  opencode:
    if: |
      contains(github.event.comment.body, ' /oc') ||
      startsWith(github.event.comment.body, '/oc') ||
      contains(github.event.comment.body, ' /opencode') ||
      startsWith(github.event.comment.body, '/opencode')
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
      pull-requests: read
      issues: read
    steps:
      - name: Checkout repository
        uses: actions/checkout@v6
        with:
          persist-credentials: false

      - name: Run opencode
        uses: anomalyco/opencode/github@latest${envStr}
        with:
          model: ${fullModel}
`
}

export interface GithubInstallResult {
  workflowFile: string
  workflowPath: string
  provider: string
  model: string
  written: boolean
  dryRun?: boolean
  secrets: string[]
  nextSteps: string[]
  appInstalled?: boolean
  content?: string
}

export function getProviderEnv(provider: string, providers?: Record<string, any>): string[] {
  if (provider === "amazon-bedrock") return []
  if (providers && providers[provider]?.env && Array.isArray(providers[provider].env)) {
    return providers[provider].env
  }
  const defaults: Record<string, string[]> = {
    anthropic: ["ANTHROPIC_API_KEY"],
    openai: ["OPENAI_API_KEY"],
    google: ["GEMINI_API_KEY"],
    deepseek: ["DEEPSEEK_API_KEY"],
    groq: ["GROQ_API_KEY"],
    mistral: ["MISTRAL_API_KEY"],
  }
  return defaults[provider] ?? []
}

export function getDefaultModel(provider: string, providers?: Record<string, any>): string {
  const models = providers && providers[provider]?.models
  if (models && typeof models === "object") {
    const keys = Object.keys(models)
    if (keys.length > 0) return keys[0]
  }
  const defaults: Record<string, string> = {
    opencode: "claude-sonnet-4-0",
    anthropic: "claude-sonnet-4-0",
    openai: "gpt-5.4",
    google: "gemini-2.5-pro",
    "amazon-bedrock": "anthropic.claude-v3-sonnet",
  }
  return defaults[provider] ?? "default"
}

export function buildNextSteps(opts: {
  workflowFile: string
  provider: string
  owner?: string
  repo?: string
  secrets?: string[]
}): string[] {
  const steps: string[] = []
  steps.push(`Commit the \`${opts.workflowFile}\` file and push`)
  if (opts.provider === "amazon-bedrock") {
    steps.push(
      "Configure OIDC in AWS - https://docs.github.com/en/actions/how-tos/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services",
    )
  } else if (opts.secrets && opts.secrets.length > 0) {
    const target = opts.owner && opts.repo ? ` (${opts.owner}/${opts.repo})` : ""
    steps.push(`Add the following secrets in org or repo${target} settings: ${opts.secrets.join(", ")}`)
  }
  steps.push("Go to a GitHub issue and comment `/oc summarize` to see the agent in action")
  steps.push("Learn more about the GitHub agent - https://opencode.ai/docs/github/#usage-examples")
  return steps
}

export function buildGithubInstallResult(opts: {
  workflowFile: string
  workflowPath: string
  provider: string
  model: string
  written: boolean
  dryRun?: boolean
  secrets?: string[]
  nextSteps?: string[]
  appInstalled?: boolean
  content?: string
}): GithubInstallResult {
  return {
    workflowFile: opts.workflowFile,
    workflowPath: opts.workflowPath,
    provider: opts.provider,
    model: opts.model,
    written: opts.written,
    ...(opts.dryRun !== undefined && { dryRun: opts.dryRun }),
    secrets: opts.secrets ?? [],
    nextSteps: opts.nextSteps ?? [],
    ...(opts.appInstalled !== undefined && { appInstalled: opts.appInstalled }),
    ...(opts.content !== undefined && { content: opts.content }),
  }
}

export function formatGithubInstallText(result: GithubInstallResult): string[] {
  const lines: string[] = []
  if (result.dryRun) {
    lines.push(`[dry-run] Would generate GitHub agent workflow: ${result.workflowFile}`)
  } else if (result.written) {
    lines.push(`Added workflow file: "${result.workflowFile}"`)
  } else {
    lines.push(`Workflow file: "${result.workflowFile}"`)
  }
  lines.push(`Provider: ${result.provider}`)
  lines.push(`Model: ${result.model}`)
  if (result.secrets.length > 0) {
    lines.push(`Required secrets: ${result.secrets.join(", ")}`)
  }
  if (result.nextSteps.length > 0) {
    lines.push("")
    lines.push("Next steps:")
    for (let i = 0; i < result.nextSteps.length; i++) {
      lines.push(`    ${i + 1}. ${result.nextSteps[i]}`)
    }
  }
  return lines
}

export async function writeOutputFile(filePath: string, content: string): Promise<string> {
  const resolved = path.resolve(filePath)
  await fs.mkdir(path.dirname(resolved), { recursive: true })
  await fs.writeFile(resolved, content, "utf-8")
  return resolved
}
