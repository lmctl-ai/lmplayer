import { describe, expect } from "bun:test"
import { Effect, Exit, Layer, Schema, Scope } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { AgentPlugin } from "@opencode-ai/core/plugin/agent"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { toolDefinitions } from "./lib/tool"
import { agentHost, host } from "./plugin/host"

const securedAllowRules = [
  { action: "apply_patch", resource: "*" },
  { action: "cp", resource: "*" },
  { action: "curl", resource: "*" },
  { action: "edit", resource: "*" },
  { action: "find", resource: "*" },
  { action: "git", resource: "blame*" },
  { action: "git", resource: "branch*" },
  { action: "git", resource: "cat-file*" },
  { action: "git", resource: "describe*" },
  { action: "git", resource: "diff*" },
  { action: "git", resource: "for-each-ref*" },
  { action: "git", resource: "grep*" },
  { action: "git", resource: "log*" },
  { action: "git", resource: "ls-files*" },
  { action: "git", resource: "ls-tree*" },
  { action: "git", resource: "remote -v*" },
  { action: "git", resource: "remote show*" },
  { action: "git", resource: "rev-parse*" },
  { action: "git", resource: "show*" },
  { action: "git", resource: "shortlog*" },
  { action: "git", resource: "status*" },
  { action: "git", resource: "tag*" },
  { action: "git", resource: "worktree list*" },
  { action: "grep", resource: "*" },
  { action: "glob", resource: "*" },
  { action: "ls", resource: "*" },
  { action: "mkdir", resource: "*" },
  { action: "mv", resource: "*" },
  { action: "read", resource: "*" },
  { action: "rg", resource: "*" },
  { action: "skill", resource: "*" },
  { action: "tar", resource: "*" },
  { action: "todowrite", resource: "*" },
  { action: "touch", resource: "*" },
  { action: "unzip", resource: "*" },
  { action: "webfetch", resource: "*" },
  { action: "websearch", resource: "*" },
  { action: "wget", resource: "*" },
  { action: "write", resource: "*" },
]
const securedBuiltInTools = [
  "apply_patch",
  "edit",
  "glob",
  "grep",
  "read",
  "skill",
  "todowrite",
  "webfetch",
  "websearch",
  "write",
]
const outputStore = Layer.mock(ToolOutputStore.Service, {
  bound: (input) => Effect.succeed({ output: input.output, outputPaths: [] }),
})

const it = testEffect(AppNodeBuilder.build(AgentV2.node))
const registryIt = testEffect(
  AppNodeBuilder.build(LayerNode.group([AgentV2.node, ToolRegistry.node]), [[ToolOutputStore.node, outputStore]]),
)

const makeTool = () =>
  Tool.make({
    description: "test tool",
    input: Schema.Struct({}),
    output: Schema.Struct({}),
    execute: () => Effect.succeed({}),
  })

describe("AgentV2", () => {
  it.effect("starts without agents", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service

      expect(yield* agent.all()).toEqual([])
      expect(yield* agent.get(AgentV2.ID.make("build"))).toBeUndefined()
    }),
  )

  it.effect("materializes replayable agent transforms", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("reviewer")
      yield* agent.transform((editor) =>
        editor.update(id, (info) => {
          info.description = "Reviews code"
          info.mode = "subagent"
        }),
      )

      expect(yield* agent.get(id)).toMatchObject({ id, description: "Reviews code", mode: "subagent" })
      expect((yield* agent.all()).map((info) => info.id)).toEqual([id])
    }),
  )

  it.effect("rebuilds state when a transform is replaced", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("reviewer")
      let description = "Old description"
      let hidden = true
      yield* agent.transform((editor) =>
        editor.update(id, (info) => {
          info.description = description
          info.hidden = hidden
        }),
      )
      description = "New description"
      hidden = false
      yield* agent.reload()

      expect(yield* agent.get(id)).toMatchObject({ description: "New description", hidden: false })
    }),
  )

  it.effect("removes a transform when its scope closes", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("scoped")
      const scope = yield* Scope.make()
      yield* agent.transform((editor) => editor.update(id, () => {})).pipe(Scope.provide(scope))
      expect(yield* agent.get(id)).toBeDefined()

      yield* Scope.close(scope, Exit.void)
      expect(yield* agent.get(id)).toBeUndefined()
    }),
  )

  it.effect("applies direct agent updates", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("build")

      yield* agent.transform((editor) =>
        editor.update(id, (info) => {
          info.mode = "primary"
          info.hidden = true
        }),
      )

      expect(yield* agent.get(id)).toMatchObject({ id, mode: "primary", hidden: true })
    }),
  )

  it.effect("creates agents with runtime defaults and supports direct removal", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("custom")

      yield* agent.transform((editor) => editor.update(id, () => {}))
      expect(yield* agent.get(id)).toEqual(AgentV2.Info.empty(id))

      yield* agent.transform((editor) => editor.remove(id))
      expect(yield* agent.get(id)).toBeUndefined()
    }),
  )

  it.effect("does not ambiently opt built-in agents into bash", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* AgentPlugin.Plugin.effect(
        host({
          agent: agentHost(agent),
        }),
      ).pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
        ),
      )

      const agents = yield* agent.all()
      expect(agents.map((item) => String(item.id)).sort()).toEqual([
        "build",
        "compaction",
        "explore",
        "general",
        "plan",
        "secured",
        "summary",
        "title",
      ])
      for (const item of agents) {
        expect(item.permissions.some((rule) => rule.action === "bash" && rule.effect !== "deny")).toBe(false)
      }
    }),
  )

  it.effect("configures secured as a zero-ask deny-by-default non-coding agent", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* AgentPlugin.Plugin.effect(
        host({
          agent: agentHost(agent),
        }),
      ).pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
        ),
      )

      const secured = yield* agent.get(AgentV2.ID.make("secured"))
      expect(secured).toMatchObject({ id: AgentV2.ID.make("secured"), mode: "primary", hidden: false })
      expect(secured?.permissions.map((rule) => rule.effect).includes("ask")).toBe(false)
      expect(secured?.permissions.filter((rule) => rule.effect === "allow")).toEqual(
        securedAllowRules.map((rule) => ({ ...rule, effect: "allow" })),
      )
      for (const rule of securedAllowRules)
        expect(PermissionV2.evaluate(rule.action, rule.resource, secured?.permissions ?? []).effect).toBe("allow")
      expect(PermissionV2.evaluate("bash", "pwd", secured?.permissions ?? []).effect).toBe("deny")
      expect(PermissionV2.evaluate("question", "Continue?", secured?.permissions ?? []).effect).toBe("deny")
      expect(PermissionV2.evaluate("external_directory", "/tmp/*", secured?.permissions ?? []).effect).toBe("deny")
      expect(PermissionV2.evaluate("read", ".env", secured?.permissions ?? []).effect).toBe("deny")
      expect(PermissionV2.evaluate("read", ".env.production", secured?.permissions ?? []).effect).toBe("deny")
      expect(PermissionV2.evaluate("read", "secrets/api-key", secured?.permissions ?? []).effect).toBe("deny")
      expect(PermissionV2.evaluate("read", "config/secrets/api-key", secured?.permissions ?? []).effect).toBe("deny")
      expect(PermissionV2.evaluate("rg", ".env", secured?.permissions ?? []).effect).toBe("deny")
      expect(PermissionV2.evaluate("find", "config/secrets", secured?.permissions ?? []).effect).toBe("deny")
      expect(PermissionV2.evaluate("git", "show HEAD:.env", secured?.permissions ?? []).effect).toBe("deny")
    }),
  )

  registryIt.effect("materializes secured without bash while preserving build bash", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* AgentPlugin.Plugin.effect(
        host({
          agent: agentHost(agent),
        }),
      ).pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
        ),
      )
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        apply_patch: Tool.withPermission(makeTool(), "edit"),
        bash: makeTool(),
        edit: Tool.withPermission(makeTool(), "edit"),
        glob: makeTool(),
        grep: makeTool(),
        question: makeTool(),
        read: makeTool(),
        skill: makeTool(),
        todowrite: makeTool(),
        webfetch: makeTool(),
        websearch: makeTool(),
        write: Tool.withPermission(makeTool(), "edit"),
      })

      const build = yield* agent.get(AgentV2.ID.make("build"))
      const secured = yield* agent.get(AgentV2.ID.make("secured"))
      const securedMaterialized = yield* registry.materialize(secured?.permissions)

      expect((yield* toolDefinitions(registry, build?.permissions)).map((tool) => tool.name)).toContain("bash")
      expect(securedMaterialized.definitions.map((tool) => tool.name).sort()).toEqual(securedBuiltInTools)
      expect(
        (yield* securedMaterialized.settle({
          sessionID: SessionV2.ID.make("ses_secured"),
          agent: AgentV2.ID.make("secured"),
          assistantMessageID: SessionMessage.ID.make("msg_secured"),
          call: { type: "tool-call", id: "call-bash", name: "bash", input: {} },
        })).result,
      ).toEqual({ type: "error", value: "Unknown tool: bash" })
      expect(
        (yield* securedMaterialized.settle({
          sessionID: SessionV2.ID.make("ses_secured"),
          agent: AgentV2.ID.make("secured"),
          assistantMessageID: SessionMessage.ID.make("msg_secured"),
          call: { type: "tool-call", id: "call-question", name: "question", input: {} },
        })).result,
      ).toEqual({ type: "error", value: "Unknown tool: question" })
    }),
  )

  it.effect("admits external read and edit by default for coding agents while preserving sensitive rules", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* AgentPlugin.Plugin.effect(
        host({
          agent: agentHost(agent),
        }),
      ).pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
        ),
      )

      const build = yield* agent.get(AgentV2.ID.make("build"))
      const general = yield* agent.get(AgentV2.ID.make("general"))

      for (const ag of [build, general]) {
        expect(ag).toBeDefined()
        const perms = ag!.permissions

        expect(PermissionV2.evaluate("external_directory", "/external/workspace/*", perms).effect).toBe("allow")
        expect(PermissionV2.evaluate("external_directory", "/tmp/*", perms).effect).toBe("allow")

        expect(PermissionV2.evaluate("read", "/external/workspace/file.ts", perms).effect).toBe("allow")
        expect(PermissionV2.evaluate("edit", "/external/workspace/file.ts", perms).effect).toBe("allow")

        expect(PermissionV2.evaluate("read", "/external/workspace/.env", perms).effect).toBe("ask")
        expect(PermissionV2.evaluate("read", "/external/workspace/.env.local", perms).effect).toBe("ask")
        expect(PermissionV2.evaluate("read", "/external/workspace/.env.example", perms).effect).toBe("allow")
      }
    }),
  )

  it.effect("allows external reads but preserves mutation denials for plan and explore agents", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* AgentPlugin.Plugin.effect(
        host({
          agent: agentHost(agent),
        }),
      ).pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
        ),
      )

      const plan = yield* agent.get(AgentV2.ID.make("plan"))
      expect(plan).toBeDefined()
      const planPerms = plan!.permissions
      expect(PermissionV2.evaluate("external_directory", "/external/workspace/*", planPerms).effect).toBe("allow")
      expect(PermissionV2.evaluate("read", "/external/workspace/file.ts", planPerms).effect).toBe("allow")
      expect(PermissionV2.evaluate("edit", "/external/workspace/file.ts", planPerms).effect).toBe("deny")
      expect(PermissionV2.evaluate("bash", "cat /external/workspace/file.ts", planPerms).effect).toBe("deny")

      const explore = yield* agent.get(AgentV2.ID.make("explore"))
      expect(explore).toBeDefined()
      const explorePerms = explore!.permissions
      expect(PermissionV2.evaluate("external_directory", "/external/workspace/*", explorePerms).effect).toBe("allow")
      expect(PermissionV2.evaluate("read", "/external/workspace/file.ts", explorePerms).effect).toBe("allow")
      expect(PermissionV2.evaluate("grep", "pattern", explorePerms).effect).toBe("allow")
      expect(PermissionV2.evaluate("glob", "*.ts", explorePerms).effect).toBe("allow")
      expect(PermissionV2.evaluate("edit", "/external/workspace/file.ts", explorePerms).effect).toBe("deny")
      expect(PermissionV2.evaluate("bash", "ls /external/workspace", explorePerms).effect).toBe("deny")
    }),
  )
})
