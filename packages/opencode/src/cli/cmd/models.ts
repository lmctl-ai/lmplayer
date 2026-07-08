import { EOL } from "os"
import { Effect } from "effect"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2"
import { Auth } from "../../auth"
import type { Provider } from "@/provider/provider"

// ─── --json wire shape ───────────────────────────────────────────────────────

export type ModelJsonEntry = {
  id: string
  provider: string
  name: string
  limit: { context: number | null; input: number | null; output: number | null }
  capabilities: { reasoning: boolean; toolcall: boolean; attachment: boolean; temperature: boolean }
  variants: string[]
  available: true
}

/**
 * Maps one Provider.Model to the `models --json` wire shape.
 * Exported for unit tests.
 */
export function modelToJsonEntry(providerID: string, modelID: string, model: Provider.Model): ModelJsonEntry {
  return {
    id: `${providerID}/${modelID}`,
    provider: providerID,
    name: model.name,
    limit: {
      context: model.limit.context ?? null,
      input: model.limit.input ?? null,
      output: model.limit.output ?? null,
    },
    capabilities: {
      reasoning: model.capabilities.reasoning,
      toolcall: model.capabilities.toolcall,
      attachment: model.capabilities.attachment,
      temperature: model.capabilities.temperature,
    },
    variants: Object.keys(model.variants ?? {}),
    available: true as const,
  }
}

// ─── verify helpers ──────────────────────────────────────────────────────────

export type VerifyResult = { ok: true } | { ok: false; reason: string }

/**
 * Pure resolver — no I/O. Checks catalog membership, provider authentication,
 * and (optionally) effort validity. Supply `builtProvider` only when --effort
 * is given; it carries the variant map built by fromModelsDevProvider so the
 * caller can defer that import to the --effort path.
 */
export function resolveVerify(
  modelId: string,
  effort: string | undefined,
  database: Record<string, ModelsDev.Provider>,
  allCreds: Record<string, Auth.Info>,
  builtProvider?: { models: Record<string, { variants?: Record<string, unknown> }> },
): VerifyResult {
  const slash = modelId.indexOf("/")
  if (slash <= 0 || slash === modelId.length - 1)
    return { ok: false, reason: `model must be in "providerID/modelID" format, got: ${modelId}` }

  const providerID = modelId.slice(0, slash)
  const modelID = modelId.slice(slash + 1)

  // ollama is config-free: no auth, and its model set is dynamic (arbitrary
  // local tags), so it isn't in the models.dev catalog to check against.
  if (providerID === "ollama") return { ok: true }

  const providerDef = database[providerID]
  if (!providerDef) return { ok: false, reason: `unknown provider "${providerID}"` }
  if (!providerDef.models[modelID])
    return { ok: false, reason: `unknown model "${modelID}" for provider "${providerID}"` }

  const isAuthed = Boolean(allCreds[providerID]) || providerDef.env.some((e) => Boolean(process.env[e]))
  if (!isAuthed) {
    const envHint = providerDef.env.length ? ` (set one of: ${providerDef.env.join(", ")})` : ""
    return { ok: false, reason: `provider "${providerID}" is not authenticated${envHint}` }
  }

  if (effort) {
    const validEfforts = Object.keys(builtProvider?.models[modelID]?.variants ?? {})
    if (!validEfforts.includes(effort)) {
      const list = validEfforts.length ? validEfforts.join(", ") : "(none)"
      return { ok: false, reason: `effort "${effort}" is not valid for ${modelId}; valid: ${list}` }
    }
  }

  return { ok: true }
}

// ─── verify subcommand ───────────────────────────────────────────────────────

const ModelsVerifyCommand = effectCmd({
  command: "verify <model>",
  describe: "verify a model is known and available; exit non-zero with a reason if not",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("model", {
        describe: 'model in "providerID/modelID" format (e.g. github-copilot/claude-sonnet-4.6)',
        type: "string",
        demandOption: true,
      })
      .option("effort", {
        alias: "e",
        describe: "effort/variant to validate (e.g. low, medium, high, xhigh, max)",
        type: "string",
      }),
  handler: Effect.fn("Cli.models.verify")(function* (args) {
    const modelId = args.model!
    const modelsDev = yield* ModelsDev.Service
    const database = yield* modelsDev.get()
    const authSvc = yield* Auth.Service
    const allCreds = yield* Effect.orDie(authSvc.all())

    // Only compute per-model variant data when --effort is given; avoids the
    // large provider.ts dynamic import on the common no-effort path.
    let builtProvider: { models: Record<string, { variants?: Record<string, unknown> }> } | undefined
    if (args.effort) {
      const slash = modelId.indexOf("/")
      if (slash > 0 && slash < modelId.length - 1) {
        const pDef = database[modelId.slice(0, slash)]
        if (pDef) {
          const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
          builtProvider = Provider.fromModelsDevProvider(pDef)
        }
      }
    }

    const result = resolveVerify(modelId, args.effort, database, allCreds, builtProvider)
    if (!result.ok) {
      process.stderr.write(`error: ${result.reason}\n`)
      process.exitCode = 1
      return
    }
    process.stdout.write(`ok: ${modelId} is available\n`)
  }),
})

// ─── models list ─────────────────────────────────────────────────────────────

export const ModelsCommand = effectCmd({
  command: "models [provider]",
  describe: "list all available models",
  builder: (yargs) =>
    yargs
      .command(ModelsVerifyCommand)
      .positional("provider", {
        describe: "provider ID to filter models by",
        type: "string",
        array: false,
      })
      .option("verbose", {
        describe: "use more verbose model output (includes metadata like costs)",
        type: "boolean",
      })
      .option("json", {
        describe: "output models as a JSON array (id, limits, capabilities, reasoning-effort variants)",
        type: "boolean",
      })
      .option("refresh", {
        describe: "refresh the models cache from models.dev",
        type: "boolean",
      })
      .option("test", {
        describe: "probe each model with a tiny prompt and report which actually work end-to-end",
        type: "boolean",
      })
      .option("timeout", {
        describe: "per-model timeout in milliseconds when using --test",
        type: "number",
        default: 60000,
      })
      .option("concurrency", {
        describe: "number of models to probe in parallel when using --test (default 1, sequential)",
        type: "number",
        default: 1,
      }),
  handler: Effect.fn("Cli.models")(function* (args) {
    const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
    if (args.refresh) {
      yield* ModelsDev.Service.use((s) => s.refresh(true))
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + "Models cache refreshed" + UI.Style.TEXT_NORMAL)
    }

    const provider = yield* Provider.Service
    const providers = yield* provider.list()

    if (args.test) {
      if (args.provider && !providers[ProviderV2.ID.make(args.provider)]) {
        return yield* fail(`Provider not found: ${args.provider}`)
      }
      // When probing ALL providers (no explicit --provider filter), skip the
      // local, config-free "ollama" provider: it may not even be running, so
      // probing its handful of seeded models would just add noise/timeouts
      // to an all-providers smoke test. `models --test ollama` (explicit)
      // still probes it.
      const targets = (args.provider ? [args.provider] : Object.keys(providers).filter((id) => id !== "ollama"))
        .flatMap((providerID) =>
          Object.keys(providers[ProviderV2.ID.make(providerID)].models)
            .sort((a, b) => a.localeCompare(b))
            .map((modelID) => ({ providerID, modelID })),
        )
      yield* Effect.promise(() =>
        runModelTests(targets, {
          json: Boolean(args.json),
          timeout: args.timeout,
          concurrency: args.concurrency,
        }),
      )
      return
    }

    const print = (providerID: ProviderV2.ID, verbose?: boolean) => {
      const p = providers[providerID]
      const sorted = Object.entries(p.models).sort(([a], [b]) => a.localeCompare(b))
      for (const [modelID, model] of sorted) {
        process.stdout.write(`${providerID}/${modelID}`)
        process.stdout.write(EOL)
        if (verbose) {
          process.stdout.write(JSON.stringify(model, null, 2))
          process.stdout.write(EOL)
        }
      }
    }

    // --json wins over --verbose. `variants` keys are the reasoning-effort
    // choices (e.g. low/medium/high/xhigh/max) an agent can select per model.
    const toJson = (providerID: ProviderV2.ID) => {
      const p = providers[providerID]
      return Object.entries(p.models)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([modelID, model]) => modelToJsonEntry(providerID as string, modelID, model))
    }

    if (args.provider) {
      const providerID = ProviderV2.ID.make(args.provider)
      if (!providers[providerID]) return yield* fail(`Provider not found: ${args.provider}`)
      if (args.json) {
        process.stdout.write(JSON.stringify(toJson(providerID), null, 2))
        process.stdout.write(EOL)
        return
      }
      print(providerID, args.verbose)
      return
    }

    const ids = Object.keys(providers).sort((a, b) => {
      const aIsOpencode = a.startsWith("opencode")
      const bIsOpencode = b.startsWith("opencode")
      if (aIsOpencode && !bIsOpencode) return -1
      if (!aIsOpencode && bIsOpencode) return 1
      return a.localeCompare(b)
    })

    if (args.json) {
      const all = ids.flatMap((providerID) => toJson(ProviderV2.ID.make(providerID)))
      process.stdout.write(JSON.stringify(all, null, 2))
      process.stdout.write(EOL)
      return
    }

    for (const providerID of ids) print(ProviderV2.ID.make(providerID), args.verbose)
  }),
})

type ProbeResult = { id: string; ok: boolean; ms: number; error: string | null }

// Probe each entitled model end-to-end through the same in-process server +
// SDK client that `run` uses, so a model that 404s at the provider (e.g.
// claude-* via copilot) shows up as FAIL instead of a green listing.
async function runModelTests(
  targets: Array<{ providerID: string; modelID: string }>,
  opts: { json: boolean; timeout: number; concurrency: number },
) {
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const { Server } = await import("@/server/server")
    const { ServerAuth } = await import("@/server/auth")
    const request = new Request(input, init)
    const headers = new Headers(request.headers)
    const auth = ServerAuth.header()
    if (auth) headers.set("Authorization", auth)
    return Server.Default().app.fetch(new Request(request, { headers }))
  }) as typeof globalThis.fetch
  const sdk = createOpencodeClient({
    baseUrl: "http://opencode.internal",
    fetch: fetchFn,
    directory: process.cwd(),
  })

  const printLine = (r: ProbeResult) =>
    process.stdout.write(
      (r.ok ? `OK   ${r.id}  (${r.ms}ms)` : `FAIL ${r.id}  (${r.ms}ms)  ${r.error ?? ""}`) + EOL,
    )

  const results: ProbeResult[] = []
  let next = 0
  const worker = async () => {
    while (true) {
      const index = next++
      if (index >= targets.length) return
      const r = await probeModel(sdk, targets[index], opts.timeout)
      results.push(r)
      if (!opts.json) printLine(r)
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(opts.concurrency, targets.length)) }, worker),
  )

  results.sort((a, b) => a.id.localeCompare(b.id))
  const okCount = results.filter((r) => r.ok).length
  const failCount = results.length - okCount

  if (opts.json) {
    process.stdout.write(JSON.stringify(results, null, 2) + EOL)
  } else {
    process.stdout.write(EOL + `${okCount} ok, ${failCount} failed` + EOL)
  }

  if (failCount > 0) process.exitCode = 1
}

async function probeModel(
  sdk: OpencodeClient,
  target: { providerID: string; modelID: string },
  timeoutMs: number,
): Promise<ProbeResult> {
  const id = `${target.providerID}/${target.modelID}`
  const start = Date.now()
  const elapsed = () => Date.now() - start
  try {
    const created = await sdk.session.create({
      title: "model-test",
      // Wildcard deny removes every tool (and question/plan) from the toolset
      // entirely, not just at execution time, so the model is offered no tools
      // and the probe is a single provider turn that cannot enter a tool loop.
      permission: [{ permission: "*", action: "deny", pattern: "*" }],
    })
    const sessionID = created.data?.id
    if (!sessionID) {
      return { id, ok: false, ms: elapsed(), error: created.error ? errorText(created.error) : "failed to create session" }
    }

    try {
      // The Promise.race timeout is the real guarantee the probe returns; the
      // AbortSignal is best-effort cancellation of in-flight provider work.
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs).unref?.(),
      )
      const result = await Promise.race([
        sdk.session.prompt(
          {
            sessionID,
            model: { providerID: target.providerID, modelID: target.modelID },
            parts: [{ type: "text", text: "Reply with: ok" }],
          },
          { signal: AbortSignal.timeout(timeoutMs) },
        ),
        timeout,
      ])
      if (result.error) return { id, ok: false, ms: elapsed(), error: errorText(result.error) }
      const infoError = result.data?.info?.error
      if (infoError) return { id, ok: false, ms: elapsed(), error: errorText(infoError) }
      return { id, ok: true, ms: elapsed(), error: null }
    } finally {
      await sdk.session.delete({ sessionID }).catch(() => {})
    }
  } catch (error) {
    return { id, ok: false, ms: elapsed(), error: errorText(error) }
  }
}

// Pull a short, human-readable message out of either a tagged API/session
// error ({ name, data: { message } }) or a thrown Error.
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object") {
    if (
      "data" in error &&
      error.data &&
      typeof error.data === "object" &&
      "message" in error.data &&
      error.data.message
    ) {
      return String(error.data.message)
    }
    if ("name" in error && error.name) return String(error.name)
    return JSON.stringify(error)
  }
  return String(error)
}
