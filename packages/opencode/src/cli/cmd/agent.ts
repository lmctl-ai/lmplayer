import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { Global } from "@opencode-ai/core/global"
import path from "path"
import fs from "fs/promises"
import { Filesystem } from "@/util/filesystem"
import matter from "gray-matter"
import { EOL } from "os"
import type { Argv } from "yargs"
import { Effect } from "effect"
import { CliError, effectCmd, fail } from "../effect-cmd"

type AgentMode = "all" | "primary" | "subagent"

// Permission keys (not raw tool names). Multiple tools can map to a single
// permission — e.g. write/edit/apply_patch all gate on `edit` — so we configure
// agents at the permission level to match how the runtime actually enforces it.
const AVAILABLE_PERMISSIONS = [
  "bash",
  "read",
  "edit",
  "glob",
  "grep",
  "webfetch",
  "task",
  "todowrite",
  "websearch",
  "lsp",
  "skill",
]

export type AgentCreateArgs = {
  name?: string
  prompt?: string
  "prompt-file"?: string
  path?: string
  description?: string
  mode?: AgentMode
  permissions?: string
  provision?: string
  model?: string
}

export const createAgent = Effect.fn("Cli.agent.create")(function* (args: AgentCreateArgs) {
  const { InstanceRef } = yield* Effect.promise(() => import("@/effect/instance-ref"))
  const maybeCtx = yield* InstanceRef
  if (!maybeCtx) return yield* Effect.die("InstanceRef not provided")
  const ctx = maybeCtx

  const hasPrompt = args.prompt !== undefined
  const hasPromptFile = args["prompt-file"] !== undefined
  if (hasPrompt && hasPromptFile) {
    return yield* fail("Cannot provide both --prompt and --prompt-file")
  }

  let systemPrompt: string | undefined
  if (hasPrompt) {
    systemPrompt = args.prompt!
  } else if (hasPromptFile) {
    const filePath = path.resolve(args["prompt-file"]!)
    systemPrompt = yield* Effect.tryPromise({
      try: () => fs.readFile(filePath, "utf-8"),
      catch: (err: any) =>
        new CliError({ message: `Failed to read prompt file "${args["prompt-file"]}": ${err.message}` }),
    })
  }

  const isBypass = systemPrompt !== undefined
  const cliPath = args.path
  const cliDescription = args.description
  const cliMode = args.mode as AgentMode | undefined
  const perms = args.permissions

  const isFullyNonInteractive =
    isBypass || !process.stdin.isTTY || Boolean(cliPath && cliDescription && cliMode && perms !== undefined)

  if (!isFullyNonInteractive) {
    UI.empty()
    prompts.intro("Create agent")
  }

  const project = ctx.project

  // Determine targetPath
  let targetPath: string
  if (cliPath) {
    targetPath = cliPath.endsWith("agents") ? cliPath : path.join(cliPath, "agents")
  } else if (isBypass || !process.stdin.isTTY) {
    const scope = project.vcs === "git" ? "project" : "global"
    targetPath = path.join(scope === "global" ? Global.Path.config : path.join(ctx.worktree, ".opencode"), "agents")
  } else {
    let scope: "global" | "project" = "global"
    if (project.vcs === "git") {
      const scopeResult = yield* Effect.promise(() =>
        prompts.select({
          message: "Location",
          options: [
            {
              label: "Current project",
              value: "project" as const,
              hint: ctx.worktree,
            },
            {
              label: "Global",
              value: "global" as const,
              hint: Global.Path.config,
            },
          ],
        }),
      )
      if (prompts.isCancel(scopeResult)) return yield* Effect.die(new UI.CancelledError())
      scope = scopeResult
    }
    targetPath = path.join(scope === "global" ? Global.Path.config : path.join(ctx.worktree, ".opencode"), "agents")
  }

  let identifier: string
  let whenToUse: string

  if (isBypass) {
    // Deterministic LLM-bypass path
    if (args.name) {
      identifier = args.name.trim()
    } else if (hasPromptFile) {
      identifier = path.basename(args["prompt-file"]!, path.extname(args["prompt-file"]!)).trim()
    } else if (!process.stdin.isTTY) {
      return yield* fail("Agent name is required when using --prompt. Supply --name <name>.")
    } else {
      const query = yield* Effect.promise(() =>
        prompts.text({
          message: "Agent name",
          placeholder: "agent-identifier",
          validate: (x) => (x && x.length > 0 ? undefined : "Required"),
        }),
      )
      if (prompts.isCancel(query)) return yield* Effect.die(new UI.CancelledError())
      identifier = query.trim()
    }

    identifier = identifier.toLowerCase().replace(/[^a-z0-9-_]/g, "-")
    if (!identifier) {
      return yield* fail("Invalid agent name")
    }

    whenToUse = cliDescription ?? identifier
  } else {
    // LLM-generation path
    let description: string
    if (cliDescription) {
      description = cliDescription
    } else if (!process.stdin.isTTY) {
      return yield* fail(
        "Description is required when running non-interactively. Supply --description <text> or use --prompt / --prompt-file.",
      )
    } else {
      const query = yield* Effect.promise(() =>
        prompts.text({
          message: "Description",
          placeholder: "What should this agent do?",
          validate: (x) => (x && x.length > 0 ? undefined : "Required"),
        }),
      )
      if (prompts.isCancel(query)) return yield* Effect.die(new UI.CancelledError())
      description = query
    }

    const { Agent } = yield* Effect.promise(() => import("../../agent/agent"))
    const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
    const agentSvc = yield* Agent.Service
    const runLocalEffect = <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.runPromise(effect.pipe(Effect.provideService(InstanceRef, ctx)))

    const spinner = prompts.spinner()
    if (!isFullyNonInteractive) {
      spinner.start("Generating agent configuration...")
    }
    const model = args.model ? Provider.parseModel(args.model) : undefined
    const generated = yield* Effect.tryPromise({
      try: () => runLocalEffect(agentSvc.generate({ description, model })),
      catch: (error: any) => {
        if (!isFullyNonInteractive) {
          spinner.stop(`LLM failed to generate agent: ${error.message}`, 1)
        }
        return error
      },
    })
    if (!isFullyNonInteractive) {
      spinner.stop(`Agent ${generated.identifier} generated`)
    }
    identifier = args.name
      ? args.name
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9-_]/g, "-")
      : generated.identifier
    systemPrompt = generated.systemPrompt
    whenToUse = generated.whenToUse
  }

  // Select permissions to allow
  let selected: string[]
  if (perms !== undefined) {
    selected = perms ? perms.split(",").map((t) => t.trim()) : AVAILABLE_PERMISSIONS
  } else if (isBypass || !process.stdin.isTTY) {
    selected = AVAILABLE_PERMISSIONS
  } else {
    const result = yield* Effect.promise(() =>
      prompts.multiselect({
        message: "Select permissions to allow (Space to toggle)",
        options: AVAILABLE_PERMISSIONS.map((permission) => ({
          label: permission,
          value: permission,
        })),
        initialValues: AVAILABLE_PERMISSIONS,
      }),
    )
    if (prompts.isCancel(result)) return yield* Effect.die(new UI.CancelledError())
    selected = result
  }

  // Get mode
  let mode: AgentMode
  if (cliMode) {
    mode = cliMode
  } else if (isBypass || !process.stdin.isTTY) {
    mode = "all"
  } else {
    const modeResult = yield* Effect.promise(() =>
      prompts.select({
        message: "Agent mode",
        options: [
          {
            label: "All",
            value: "all" as const,
            hint: "Can function in both primary and subagent roles",
          },
          {
            label: "Primary",
            value: "primary" as const,
            hint: "Acts as a primary/main agent",
          },
          {
            label: "Subagent",
            value: "subagent" as const,
            hint: "Can be used as a subagent by other agents",
          },
        ],
        initialValue: "all" as const,
      }),
    )
    if (prompts.isCancel(modeResult)) return yield* Effect.die(new UI.CancelledError())
    mode = modeResult
  }

  // Build permissions config — deny anything not explicitly selected.
  const permissions: Record<string, "deny"> = {}
  for (const permission of AVAILABLE_PERMISSIONS) {
    if (!selected.includes(permission)) {
      permissions[permission] = "deny"
    }
  }

  // Provision allowlist if provided
  const provision = args.provision
    ? args.provision
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : undefined

  // Build frontmatter
  const frontmatter: {
    description: string
    mode: AgentMode
    model?: string
    provision?: string[]
    permission?: Record<string, "deny">
  } = {
    description: whenToUse,
    mode,
  }
  if (args.model) {
    frontmatter.model = args.model
  }
  if (provision && provision.length > 0) {
    frontmatter.provision = provision
  }
  if (Object.keys(permissions).length > 0) {
    frontmatter.permission = permissions
  }

  // Write file
  const content = matter.stringify(systemPrompt!, frontmatter)
  const filePath = path.join(targetPath, `${identifier}.md`)

  yield* Effect.promise(() => fs.mkdir(targetPath, { recursive: true }))

  if (yield* Effect.promise(() => Filesystem.exists(filePath))) {
    return yield* fail(`Agent file already exists: ${filePath}`)
  }

  yield* Effect.promise(() => Filesystem.write(filePath, content))

  if (isFullyNonInteractive) {
    process.stdout.write(filePath + EOL)
  } else {
    prompts.log.success(`Agent created: ${filePath}`)
    prompts.outro("Done")
  }
})

export const AgentCreateCommand = effectCmd({
  command: "create",
  describe: "create a new agent",
  builder: (yargs: Argv) =>
    yargs
      .option("name", {
        type: "string",
        describe: "agent identifier / file name",
      })
      .option("prompt", {
        type: "string",
        describe: "system prompt content (bypasses LLM generation)",
      })
      .option("prompt-file", {
        type: "string",
        alias: ["prompt_file"],
        describe: "path to file containing system prompt content (bypasses LLM generation)",
      })
      .option("path", {
        type: "string",
        describe: "directory path to generate the agent file",
      })
      .option("description", {
        type: "string",
        describe: "what the agent should do",
      })
      .option("mode", {
        type: "string",
        describe: "agent mode",
        choices: ["all", "primary", "subagent"] as const,
      })
      .option("permissions", {
        type: "string",
        alias: ["tools"],
        describe: `comma-separated list of permissions to allow (default: all). Available: "${AVAILABLE_PERMISSIONS.join(", ")}"`,
      })
      .option("provision", {
        type: "string",
        describe: "comma-separated list of tools to provision (profile tool allowlist)",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      }),
  handler: createAgent,
})

export const AgentListCommand = effectCmd({
  command: "list",
  describe: "list all available agents",
  handler: Effect.fn("Cli.agent.list")(function* () {
    const { Agent } = yield* Effect.promise(() => import("../../agent/agent"))
    const agents = yield* Agent.Service.use((svc) => svc.list())
    const sortedAgents = agents.sort((a, b) => {
      if (a.native !== b.native) {
        return a.native ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })

    for (const agent of sortedAgents) {
      process.stdout.write(`${agent.name} (${agent.mode})` + EOL)
      process.stdout.write(`  ${JSON.stringify(agent.permission, null, 2)}` + EOL)
    }
  }),
})

export const AgentCommand = cmd({
  command: "agent",
  describe: "manage agents",
  builder: (yargs) => yargs.command(AgentCreateCommand).command(AgentListCommand).demandCommand(),
  async handler() {},
})
