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
  n?: string
  prompt?: string
  p?: string
  "prompt-file"?: string
  prompt_file?: string
  path?: string
  description?: string
  d?: string
  mode?: AgentMode
  permissions?: string
  tools?: string
  perms?: string
  provision?: string
  model?: string
  m?: string
  json?: boolean
  output?: string
  o?: string
}

export const createAgent = Effect.fn("Cli.agent.create")(function* (args: AgentCreateArgs) {
  const { InstanceRef } = yield* Effect.promise(() => import("@/effect/instance-ref"))
  const maybeCtx = yield* InstanceRef
  if (!maybeCtx) return yield* Effect.die("InstanceRef not provided")
  const ctx = maybeCtx

  const promptArg = args.prompt ?? args.p
  const promptFileArg = args["prompt-file"] ?? (args as any).prompt_file
  const hasPrompt = promptArg !== undefined
  const hasPromptFile = promptFileArg !== undefined
  if (hasPrompt && hasPromptFile) {
    return yield* fail("Cannot provide both --prompt and --prompt-file")
  }

  let systemPrompt: string | undefined
  if (hasPrompt) {
    systemPrompt = promptArg!
  } else if (hasPromptFile) {
    const filePath = path.resolve(promptFileArg!)
    systemPrompt = yield* Effect.tryPromise({
      try: () => fs.readFile(filePath, "utf-8"),
      catch: (err: any) =>
        new CliError({ message: `Failed to read prompt file "${promptFileArg}": ${err.message}` }),
    })
  }

  const isBypass = systemPrompt !== undefined
  const cliPath = args.path
  const cliDescription = args.description ?? args.d
  const cliMode = args.mode as AgentMode | undefined
  const perms: string | undefined = args.permissions ?? (args as any).tools ?? (args as any).perms
  const modelArg = args.model ?? args.m
  const output = args.output ?? args.o
  const json = Boolean(args.json)

  const isFullyNonInteractive =
    isBypass ||
    !process.stdin.isTTY ||
    Boolean(cliPath && cliDescription && cliMode && perms !== undefined) ||
    Boolean(json || output)

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
    const nameArg = args.name ?? args.n
    if (nameArg) {
      identifier = nameArg.trim()
    } else if (hasPromptFile) {
      identifier = path.basename(promptFileArg!, path.extname(promptFileArg!)).trim()
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
  if (modelArg) {
    frontmatter.model = modelArg
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

  const summaryPayload = {
    name: identifier,
    file: filePath,
    mode,
    model: frontmatter.model,
    description: whenToUse,
    provision: frontmatter.provision,
  }
  const summaryText = `Agent created: ${filePath}`

  if (output) {
    const resolved = path.resolve(output)
    yield* Effect.promise(async () => {
      const fs = await import("fs/promises")
      await fs.mkdir(path.dirname(resolved), { recursive: true })
      if (json) {
        await fs.writeFile(resolved, JSON.stringify(summaryPayload, null, 2) + EOL, "utf-8")
      } else {
        await fs.writeFile(resolved, summaryText + EOL, "utf-8")
      }
    })
    UI.println(`Wrote agent creation result to ${resolved}`)
    return
  }

  if (json) {
    process.stdout.write(JSON.stringify(summaryPayload, null, 2) + EOL)
    return
  }

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
        alias: ["n"],
        describe: "agent identifier / file name",
      })
      .option("prompt", {
        type: "string",
        alias: ["p"],
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
        alias: ["d"],
        describe: "what the agent should do",
      })
      .option("mode", {
        type: "string",
        describe: "agent mode",
        choices: ["all", "primary", "subagent"] as const,
      })
      .option("permissions", {
        type: "string",
        alias: ["tools", "perms"],
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
      })
      .option("json", {
        type: "boolean",
        describe: "output JSON",
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write creation result to output file path",
      }),
  handler: createAgent,
})

export type AgentCloneArgs = {
  source: string
  target: string
  path?: string
  scope?: "project" | "global"
  s?: "project" | "global"
  description?: string
  d?: string
  model?: string
  m?: string
  force?: boolean
  f?: boolean
  json?: boolean
  output?: string
  o?: string
}

export const cloneAgent = Effect.fn("Cli.agent.clone")(function* (args: AgentCloneArgs) {
  const { Agent } = yield* Effect.promise(() => import("../../agent/agent"))
  const { InstanceRef } = yield* Effect.promise(() => import("@/effect/instance-ref"))
  const maybeCtx = yield* InstanceRef
  if (!maybeCtx) return yield* Effect.die("InstanceRef not provided")
  const ctx = maybeCtx

  const description = args.description ?? args.d
  const model = args.model ?? args.m
  const force = Boolean(args.force ?? args.f)
  const scope = args.scope ?? args.s
  const output = args.output ?? args.o
  const json = Boolean(args.json)

  const agent = yield* Agent.Service.use((svc) => svc.get(args.source))
  if (!agent) {
    return yield* fail(`Agent not found: ${args.source}`)
  }

  const target = args.target.trim()
  if (!/^[a-zA-Z0-9_-]+$/.test(target)) {
    return yield* fail(`Invalid agent name "${target}". Must contain only letters, numbers, dashes, and underscores.`)
  }

  const existing = yield* Agent.Service.use((svc) => svc.get(target))
  if (existing?.native) {
    return yield* fail(`Cannot overwrite built-in agent: ${target}`)
  }
  if (existing && !force) {
    return yield* fail(`Agent already exists: ${target}`)
  }

  let targetPath: string
  if (args.path) {
    targetPath = args.path.endsWith("agents") ? args.path : path.join(args.path, "agents")
  } else if (scope === "global") {
    targetPath = path.join(Global.Path.config, "agents")
  } else if (ctx.project.vcs === "git") {
    targetPath = path.join(ctx.worktree, ".opencode", "agents")
  } else {
    targetPath = path.join(Global.Path.config, "agents")
  }

  const frontmatter: {
    description: string
    mode: AgentMode
    model?: string
    variant?: string
    provision?: string[]
    permission?: any
  } = {
    description: description ?? agent.description ?? `Cloned from ${args.source}`,
    mode: agent.mode,
  }
  if (model) {
    frontmatter.model = model
  } else if (agent.model) {
    frontmatter.model = `${agent.model.providerID}/${agent.model.modelID}`
  }
  if (agent.variant) {
    frontmatter.variant = agent.variant
  }
  if (agent.provision && agent.provision.length > 0) {
    frontmatter.provision = agent.provision
  }
  if (agent.permission && Object.keys(agent.permission).length > 0) {
    frontmatter.permission = agent.permission
  }

  const filePath = path.join(targetPath, `${target}.md`)
  yield* Effect.promise(() => fs.mkdir(targetPath, { recursive: true }))

  if (!force && (yield* Effect.promise(() => Filesystem.exists(filePath)))) {
    return yield* fail(`Agent file already exists: ${filePath}`)
  }

  const promptContent = agent.prompt ? agent.prompt.trim() : ""
  const content = matter.stringify(promptContent ? `\n${promptContent}\n` : "", frontmatter)
  yield* Effect.promise(() => Filesystem.write(filePath, content))

  const summaryPayload = {
    source: args.source,
    target,
    file: filePath,
    mode: frontmatter.mode,
    model: frontmatter.model,
  }
  const summaryText = `Agent "${args.source}" cloned to "${target}" (${filePath})`

  if (output) {
    const resolved = path.resolve(output)
    yield* Effect.promise(async () => {
      const fs = await import("fs/promises")
      await fs.mkdir(path.dirname(resolved), { recursive: true })
      if (json) {
        await fs.writeFile(resolved, JSON.stringify(summaryPayload, null, 2) + EOL, "utf-8")
      } else {
        await fs.writeFile(resolved, summaryText + EOL, "utf-8")
      }
    })
    UI.println(`Wrote clone result to ${resolved}`)
    return
  }

  if (json) {
    process.stdout.write(JSON.stringify(summaryPayload, null, 2) + EOL)
    return
  }

  UI.println(UI.Style.TEXT_SUCCESS_BOLD + summaryText + UI.Style.TEXT_NORMAL)
})

export const AgentCloneCommand = effectCmd({
  command: "clone <source> <target>",
  aliases: ["copy", "cp"],
  describe: "clone an existing agent into a new custom agent",
  builder: (yargs: Argv) =>
    yargs
      .positional("source", {
        type: "string",
        describe: "source agent to clone",
        demandOption: true,
      })
      .positional("target", {
        type: "string",
        describe: "new agent identifier",
        demandOption: true,
      })
      .option("path", {
        type: "string",
        describe: "directory path to generate the agent file",
      })
      .option("scope", {
        type: "string",
        alias: ["s"],
        describe: "agent scope (project or global)",
        choices: ["project", "global"] as const,
      })
      .option("description", {
        type: "string",
        alias: ["d"],
        describe: "custom description for the cloned agent",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "override model in provider/model format",
      })
      .option("force", {
        type: "boolean",
        alias: ["f"],
        describe: "overwrite existing agent file if it exists",
      })
      .option("json", {
        type: "boolean",
        describe: "output JSON",
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write clone result to output file path",
      }),
  handler: cloneAgent,
})

export type AgentListArgs = {
  json?: boolean
  mode?: "all" | "primary" | "subagent"
  output?: string
  o?: string
  search?: string
  q?: string
  query?: string
  native?: boolean
}

export const listAgents = Effect.fn("Cli.agent.list")(function* (args: AgentListArgs) {
  const { Agent } = yield* Effect.promise(() => import("../../agent/agent"))
  let agents = yield* Agent.Service.use((svc) => svc.list())

  const output = args.output ?? args.o
  const json = Boolean(args.json)
  const search = args.search ?? args.q ?? args.query
  const mode = args.mode
  const native = args.native

  if (mode) {
    agents = agents.filter((a) => a.mode === mode || a.mode === "all")
  }

  if (search) {
    const q = search.toLowerCase()
    agents = agents.filter((a) => {
      if (a.name.toLowerCase().includes(q)) return true
      if (a.description && a.description.toLowerCase().includes(q)) return true
      if (a.model && `${a.model.providerID}/${a.model.modelID}`.toLowerCase().includes(q)) return true
      return false
    })
  }

  if (native !== undefined) {
    agents = agents.filter((a) => Boolean(a.native) === native)
  }

  const sortedAgents = agents.sort((a, b) => {
    if (a.native !== b.native) {
      return a.native ? -1 : 1
    }
    return a.name.localeCompare(b.name)
  })

  if (json) {
    const jsonStr =
      JSON.stringify(
        sortedAgents.map((a) => ({
          name: a.name,
          description: a.description,
          mode: a.mode,
          native: a.native ?? false,
          model: a.model ? `${a.model.providerID}/${a.model.modelID}` : undefined,
          variant: a.variant,
          provision: a.provision,
          permission: a.permission,
        })),
        null,
        2,
      ) + EOL
    if (output) {
      const resolved = path.resolve(output)
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        await fs.writeFile(resolved, jsonStr, "utf-8")
      })
      UI.println(`Wrote agents list to ${resolved}`)
      return
    }
    process.stdout.write(jsonStr)
    return
  }

  if (output) {
    const lines: string[] = []
    for (const agent of sortedAgents) {
      const tag = agent.native ? " (built-in)" : ""
      const modelStr = agent.model ? ` [model: ${agent.model.providerID}/${agent.model.modelID}]` : ""
      lines.push(`${agent.name} (${agent.mode})${tag}${modelStr}`)
      if (agent.description) {
        lines.push(`  ${agent.description}`)
      }
      if (agent.provision && agent.provision.length > 0) {
        lines.push(`  provision: ${agent.provision.join(", ")}`)
      }
    }
    const resolved = path.resolve(output)
    yield* Effect.promise(async () => {
      await fs.mkdir(path.dirname(resolved), { recursive: true })
      await fs.writeFile(resolved, lines.join(EOL) + EOL, "utf-8")
    })
    UI.println(`Wrote agents list to ${resolved}`)
    return
  }

  for (const agent of sortedAgents) {
    const tag = agent.native ? " (built-in)" : ""
    const modelStr = agent.model ? ` [model: ${agent.model.providerID}/${agent.model.modelID}]` : ""
    process.stdout.write(`${agent.name} (${agent.mode})${tag}${modelStr}` + EOL)
    if (agent.description) {
      process.stdout.write(`  ${agent.description}` + EOL)
    }
    if (agent.provision && agent.provision.length > 0) {
      process.stdout.write(`  provision: ${agent.provision.join(", ")}` + EOL)
    }
  }
})

export type AgentShowArgs = {
  name: string
  json?: boolean
  output?: string
  o?: string
}

export const showAgent = Effect.fn("Cli.agent.show")(function* (args: AgentShowArgs) {
  const { Agent } = yield* Effect.promise(() => import("../../agent/agent"))
  const agent = yield* Agent.Service.use((svc) => svc.get(args.name))

  if (!agent) {
    return yield* fail(`Agent not found: ${args.name}`)
  }

  const output = args.output ?? args.o
  const json = Boolean(args.json)

  if (json) {
    const jsonStr =
      JSON.stringify(
        {
          name: agent.name,
          description: agent.description,
          mode: agent.mode,
          native: agent.native ?? false,
          model: agent.model ? `${agent.model.providerID}/${agent.model.modelID}` : undefined,
          variant: agent.variant,
          provision: agent.provision,
          prompt: agent.prompt,
          permission: agent.permission,
        },
        null,
        2,
      ) + EOL
    if (output) {
      const resolved = path.resolve(output)
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        await fs.writeFile(resolved, jsonStr, "utf-8")
      })
      UI.println(`Wrote agent details to ${resolved}`)
      return
    }
    process.stdout.write(jsonStr)
    return
  }

  if (output) {
    const lines: string[] = []
    const tag = agent.native ? " (built-in)" : ""
    lines.push(`${agent.name} (${agent.mode})${tag}`)
    if (agent.description) {
      lines.push(`  Description: ${agent.description}`)
    }
    if (agent.model) {
      lines.push(`  Model: ${agent.model.providerID}/${agent.model.modelID}`)
    }
    if (agent.variant) {
      lines.push(`  Variant: ${agent.variant}`)
    }
    if (agent.provision && agent.provision.length > 0) {
      lines.push(`  Provision: ${agent.provision.join(", ")}`)
    }
    if (agent.prompt) {
      lines.push(`  Prompt: ${agent.prompt.trim()}`)
    }
    lines.push(`  Permissions: ${JSON.stringify(agent.permission, null, 2)}`)
    const resolved = path.resolve(output)
    yield* Effect.promise(async () => {
      await fs.mkdir(path.dirname(resolved), { recursive: true })
      await fs.writeFile(resolved, lines.join(EOL) + EOL, "utf-8")
    })
    UI.println(`Wrote agent details to ${resolved}`)
    return
  }

  const tag = agent.native ? " (built-in)" : ""
  process.stdout.write(`${agent.name} (${agent.mode})${tag}` + EOL)
  if (agent.description) {
    process.stdout.write(`  Description: ${agent.description}${EOL}`)
  }
  if (agent.model) {
    process.stdout.write(`  Model: ${agent.model.providerID}/${agent.model.modelID}${EOL}`)
  }
  if (agent.variant) {
    process.stdout.write(`  Variant: ${agent.variant}${EOL}`)
  }
  if (agent.provision && agent.provision.length > 0) {
    process.stdout.write(`  Provision: ${agent.provision.join(", ")}${EOL}`)
  }
  if (agent.prompt) {
    process.stdout.write(`  Prompt: ${agent.prompt.trim()}${EOL}`)
  }
  process.stdout.write(`  Permissions: ${JSON.stringify(agent.permission, null, 2)}${EOL}`)
})

export type AgentDeleteArgs = {
  name: string
  json?: boolean
  force?: boolean
  f?: boolean
  output?: string
  o?: string
}

export const deleteAgent = Effect.fn("Cli.agent.delete")(function* (args: AgentDeleteArgs) {
  const { Agent } = yield* Effect.promise(() => import("../../agent/agent"))
  const { InstanceRef } = yield* Effect.promise(() => import("@/effect/instance-ref"))
  const maybeCtx = yield* InstanceRef
  if (!maybeCtx) return yield* Effect.die("InstanceRef not provided")
  const ctx = maybeCtx

  const agent = yield* Agent.Service.use((svc) => svc.get(args.name))

  if (agent?.native) {
    return yield* fail(`Cannot delete built-in agent: ${args.name}`)
  }

  const force = Boolean(args.force ?? args.f)
  const output = args.output ?? args.o
  const json = Boolean(args.json)

  const candidates = [
    path.join(ctx.worktree, ".opencode", "agents", `${args.name}.md`),
    path.join(ctx.worktree, ".opencode", "agent", `${args.name}.md`),
    path.join(ctx.worktree, "agents", `${args.name}.md`),
    path.join(ctx.worktree, "agent", `${args.name}.md`),
    path.join(Global.Path.config, "agents", `${args.name}.md`),
    path.join(Global.Path.config, "agent", `${args.name}.md`),
  ]

  let deletedPath: string | undefined
  for (const file of candidates) {
    if (yield* Effect.promise(() => Filesystem.exists(file))) {
      yield* Effect.promise(() => fs.unlink(file))
      deletedPath = file
      break
    }
  }

  if (!deletedPath) {
    const { Config } = yield* Effect.promise(() => import("@/config/config"))
    const cfg = yield* Config.Service.use((c) => c.get())
    if (cfg.agent && args.name in cfg.agent) {
      yield* Config.Service.use((c) => c.unsetProject(["agent", args.name]))
      yield* Config.Service.use((c) => c.unsetGlobal(["agent", args.name]))
      deletedPath = "config.json"
    }
  }

  if (!deletedPath) {
    if (force) {
      if (json) {
        const payload = {
          name: args.name,
          deleted: false,
          message: `Agent not found: ${args.name}`,
        }
        const jsonStr = JSON.stringify(payload, null, 2) + EOL
        if (output) {
          const resolved = path.resolve(output)
          yield* Effect.promise(async () => {
            await fs.mkdir(path.dirname(resolved), { recursive: true })
            await fs.writeFile(resolved, jsonStr, "utf-8")
          })
        }
        process.stdout.write(jsonStr)
        return
      }
      if (output) {
        const resolved = path.resolve(output)
        yield* Effect.promise(async () => {
          await fs.mkdir(path.dirname(resolved), { recursive: true })
          await fs.writeFile(resolved, `Agent not found: ${args.name}${EOL}`, "utf-8")
        })
      }
      UI.println(`Agent not found: ${args.name}`)
      return
    }
    return yield* fail(`Agent not found: ${args.name}`)
  }

  if (json) {
    const payload = {
      name: args.name,
      file: deletedPath,
      deleted: true,
    }
    const jsonStr = JSON.stringify(payload, null, 2) + EOL
    if (output) {
      const resolved = path.resolve(output)
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        await fs.writeFile(resolved, jsonStr, "utf-8")
      })
    }
    process.stdout.write(jsonStr)
    return
  }

  if (output) {
    const resolved = path.resolve(output)
    yield* Effect.promise(async () => {
      await fs.mkdir(path.dirname(resolved), { recursive: true })
      await fs.writeFile(resolved, `Agent ${args.name} deleted (${deletedPath})${EOL}`, "utf-8")
    })
  }

  UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Agent ${args.name} deleted (${deletedPath})` + UI.Style.TEXT_NORMAL)
})

export const AgentListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list all available agents",
  builder: (yargs: Argv) =>
    yargs
      .option("json", {
        type: "boolean",
        describe: "output JSON",
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write agents list to output file path",
      })
      .option("search", {
        alias: ["q", "query"],
        type: "string",
        describe: "filter agents by name, description, or model",
      })
      .option("native", {
        type: "boolean",
        describe: "filter built-in vs custom agents",
      })
      .option("mode", {
        type: "string",
        describe: "filter by agent mode",
        choices: ["all", "primary", "subagent"] as const,
      }),
  handler: listAgents,
})

export const AgentShowCommand = effectCmd({
  command: "show <name>",
  aliases: ["get"],
  describe: "show agent details",
  builder: (yargs: Argv) =>
    yargs
      .positional("name", {
        type: "string",
        describe: "agent identifier",
        demandOption: true,
      })
      .option("json", {
        type: "boolean",
        describe: "output JSON",
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write agent details to output file path",
      }),
  handler: showAgent,
})

export const AgentDeleteCommand = effectCmd({
  command: "delete <name>",
  aliases: ["rm"],
  describe: "delete a custom agent",
  builder: (yargs: Argv) =>
    yargs
      .positional("name", {
        type: "string",
        describe: "agent identifier",
        demandOption: true,
      })
      .option("force", {
        alias: "f",
        type: "boolean",
        describe: "do not exit non-zero if agent is not found",
      })
      .option("json", {
        type: "boolean",
        describe: "output JSON",
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write deletion result to output file path",
      }),
  handler: deleteAgent,
})

export const AgentCommand = cmd({
  command: "agent",
  describe: "manage agents",
  builder: (yargs) =>
    yargs
      .command(AgentCreateCommand)
      .command(AgentCloneCommand)
      .command(AgentListCommand)
      .command(AgentShowCommand)
      .command(AgentDeleteCommand)
      .demandCommand(),
  async handler() {},
})
