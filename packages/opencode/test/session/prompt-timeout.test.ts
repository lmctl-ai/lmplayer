// End-to-end coverage for the aggregate turn deadline (Tier 1): a turn that
// wedges outside the provider stream must be cancelled, recorded on the
// assistant message, released from the process-global gate permit, and leave the
// session idle. The unit-level deadline behavior lives in
// test/server/execution-gate.test.ts; this file proves the turn actually fails
// that way and that the gate is usable afterwards.
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { afterEach, expect } from "bun:test"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Agent as AgentSvc } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Instruction } from "@/session/instruction"
import { LLM } from "@/session/llm"
import { MessageV2 } from "@/session/message-v2"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Question } from "@/question"
import { Session } from "@/session/session"
import { SessionCompaction } from "@/session/compaction"
import { SessionCronRuntime } from "@/session/cron-runtime"
import { SessionProcessor } from "@/session/processor"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Skill } from "@/skill"
import { Snapshot } from "@/snapshot"
import { SystemPrompt } from "@/session/system"
import { Todo } from "@/session/todo"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { Git } from "@/git"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "@/format"
import { Image } from "@/image/image"
import { Env } from "@/env"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { clearSessionTurnTimeout, getSessionTurnTimeout, serialize } from "@/server/execution-gate"

afterEach(async () => {
  await disposeAllInstances()
})

// The first processor run never settles: the deadline is the only way that turn
// can end, exactly like a turn parked in a tool, a lock, or a stalled event loop.
// Later runs finish cleanly so the test can prove the gate is usable afterwards.
const firstRunStalls = Effect.sync(() => ({ stalled: false }))
const stallOnceProcessor = Layer.effect(
  SessionProcessor.Service,
  Effect.gen(function* () {
    const state = yield* firstRunStalls
    return SessionProcessor.Service.of({
      create: (input) =>
        state.stalled
          ? Effect.sync(() => {
              // Finish the turn without touching the provider: the test's second
              // turn exists only to prove the gate is usable after the first one
              // was cut off by the deadline.
              input.assistantMessage.finish = "stop"
              input.assistantMessage.time.completed = Date.now()
              return {
                message: input.assistantMessage,
                updateToolCall: () => Effect.succeed(undefined),
                completeToolCall: () => Effect.void,
                process: () => Effect.succeed("stop" as const),
              }
            })
          : Effect.sync(() => {
              state.stalled = true
            }).pipe(Effect.andThen(Effect.never)),
    })
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in turn-timeout tests"),
    authenticate: () => Effect.die("unexpected MCP auth in turn-timeout tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in turn-timeout tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const runtimeFlags = RuntimeFlags.layer({ experimentalEventSystem: true })

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      SessionPrompt.node,
      Session.node,
      SessionProjector.node,
      MessageV2.node,
      Snapshot.node,
      LLM.node,
      Env.node,
      AgentSvc.node,
      Command.node,
      Permission.node,
      Plugin.node,
      Config.node,
      ProviderSvc.node,
      BackgroundJob.node,
      SessionStatus.node,
      SessionRunState.node,
      Database.node,
      EventV2Bridge.node,
      Question.node,
      Todo.node,
      ToolRegistry.node,
      Skill.node,
      Git.node,
      Ripgrep.node,
      Format.node,
      Truncate.node,
      SessionProcessor.node,
      Image.node,
      SessionCompaction.node,
      SessionRevert.node,
      Instruction.node,
      SystemPrompt.node,
      CrossSpawnSpawner.node,
      RuntimeFlags.node,
      SessionCronRuntime.node,
    ]),
    [
      [SessionSummary.node, summary],
      [LSP.node, lsp],
      [MCP.node, mcp],
      [RuntimeFlags.node, runtimeFlags],
      [SessionProcessor.node, stallOnceProcessor],
    ],
  ),
)

const timeoutMs = 500

it.instance(
  "a turn that outlives the aggregate deadline is cancelled, recorded, and releases the gate",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const runState = yield* SessionRunState.Service
      const status = yield* SessionStatus.Service

      const chat = yield* sessions.create({ title: "Turn deadline" })
      yield* Effect.addFinalizer(() => Effect.sync(() => clearSessionTurnTimeout(chat.id)))

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "first" }],
      })

      const turn = yield* serialize(prompt.loop({ sessionID: chat.id }), {
        sessionID: chat.id,
        timeoutMs,
        onDeadline: prompt.cancel(chat.id),
      }).pipe(Effect.exit, Effect.forkChild)
      // Queue a gated probe while the turn still holds the permit, so a deadline
      // that failed to release it would block here until the probe's own deadline.
      const queued = yield* serialize(Effect.succeed("released"), { sessionID: chat.id, timeoutMs: 5_000 }).pipe(
        Effect.exit,
        Effect.forkChild,
      )

      const [turnExit, queuedExit] = (yield* Fiber.awaitAll([turn, queued])).map((exit) =>
        // `Effect.exit` inside a forked fiber reports an Exit wrapping the inner
        // Exit, so unwrap the fiber's own exit to reach the turn's outcome.
        Exit.isSuccess(exit) ? (exit.value as Exit.Exit<unknown, unknown>) : exit,
      )

      // Aborting the turn interrupts its runner run, and that cleanup may win the
      // race with the caller's own interruption, so the caller observes either the
      // deadline failure or cleanup's value. Both mean the same thing: the deadline
      // ended the turn. test/server/execution-gate.test.ts pins the failure
      // semantics of the bare deadline; here the recorded message is the proof.
      const deadlineFailure = Exit.isFailure(turnExit) ? Cause.findErrorOption(turnExit.cause) : undefined
      expect(deadlineFailure === undefined || deadlineFailure._tag === "Some").toBe(true)

      const assistants = (yield* sessions.messages({ sessionID: chat.id }))
        .filter((message) => message.info.role === "assistant")
        .map((message) => message.info)
        .filter((info) => info.role === "assistant")
      const timedOut = assistants.at(-1)
      expect(timedOut?.error?.name).toBe("TurnTimeoutError")
      if (timedOut?.error?.name !== "TurnTimeoutError") throw new Error("expected TurnTimeoutError on the message")
      expect(timedOut.error.data.timeoutMs).toBe(timeoutMs)
      // The prompt loop consumes the gate's record, so no later turn inherits it.
      expect(timedOut.time.completed).toBeNumber()
      expect(getSessionTurnTimeout(chat.id)).toBeUndefined()

      // The permit was released and the session settled back to idle.
      expect(Exit.isSuccess(queuedExit)).toBe(true)
      if (Exit.isSuccess(queuedExit)) expect(queuedExit.value).toBe("released")
      yield* runState.assertNotBusy(chat.id)
      expect((yield* status.get(chat.id)).type).toBe("idle")
    }),
  20_000,
)
