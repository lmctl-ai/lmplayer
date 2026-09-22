import type { Argv } from "yargs"
import { Auth } from "../../auth"
import { cmd } from "./cmd"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import * as Prompt from "../effect/prompt"
import { ModelsDev } from "@opencode-ai/core/models-dev"

import { map, pipe, sortBy, values } from "remeda"
import path from "path"
import os from "os"
import { Config } from "@/config/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Global } from "@opencode-ai/core/global"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Plugin } from "../../plugin"
import type { Hooks } from "@opencode-ai/plugin"
import { Process } from "@/util/process"
import { errorMessage } from "@/util/error"
import { text } from "node:stream/consumers"
import { Effect, Option } from "effect"

type PluginAuth = NonNullable<Hooks["auth"]>

const promptValue = <Value>(value: Option.Option<Value>) => {
  if (Option.isNone(value)) return Effect.die(new UI.CancelledError())
  return Effect.succeed(value.value)
}

const put = Effect.fn("Cli.providers.put")(function* (key: string, info: Auth.Info) {
  const auth = yield* Auth.Service
  yield* Effect.orDie(auth.set(key, info))
})

const cliTry = <Value>(message: string, fn: () => PromiseLike<Value>) =>
  Effect.tryPromise({
    try: fn,
    catch: (error) => new CliError({ message: message + errorMessage(error) }),
  })

export const resolveApiKey = Effect.fn("Cli.providers.resolveApiKey")(function* (keyArg?: string) {
  if (keyArg) {
    if (keyArg === "-") {
      const piped = yield* cliTry("Failed to read API key from stdin: ", () => Bun.stdin.text())
      const key = piped.trim()
      if (!key) return yield* fail("No API key provided via stdin")
      return key
    }
    const key = keyArg.trim()
    if (!key) return yield* fail("API key cannot be empty")
    return key
  }
  if (!process.stdin.isTTY) {
    const piped = yield* cliTry("Failed to read API key from stdin: ", () => Bun.stdin.text())
    const key = piped.trim()
    if (key) return key
    return yield* fail("No API key provided. When running non-interactively, supply --key <key> or pipe via stdin.")
  }
  const entered = yield* Prompt.password({
    message: "Enter your API key",
    validate: (x) => (x && x.length > 0 ? undefined : "Required"),
  })
  return yield* promptValue(entered)
})

const handlePluginAuth = Effect.fn("Cli.providers.pluginAuth")(function* (
  plugin: { auth: PluginAuth },
  provider: string,
  methodName?: string,
  keyArg?: string,
) {
  const index = yield* Effect.gen(function* () {
    if (!methodName) {
      if (keyArg) {
        const apiIndex = plugin.auth.methods.findIndex((x) => x.type === "api")
        if (apiIndex !== -1) return apiIndex
      }
      if (plugin.auth.methods.length <= 1) return 0
      if (!process.stdin.isTTY) {
        return yield* fail(
          `Login method is required when running non-interactively for ${provider}. Supply --method <method>. Available: ${plugin.auth.methods.map((x) => x.label).join(", ")}`,
        )
      }
      return yield* promptValue(
        yield* Prompt.select({
          message: "Login method",
          options: plugin.auth.methods.map((x, index) => ({
            label: x.label,
            value: index,
          })),
        }),
      )
    }
    const match = plugin.auth.methods.findIndex((x) => x.label.toLowerCase() === methodName.toLowerCase())
    if (match === -1) {
      return yield* fail(
        `Unknown method "${methodName}" for ${provider}. Available: ${plugin.auth.methods.map((x) => x.label).join(", ")}`,
      )
    }
    return match
  })
  const method = plugin.auth.methods[index]

  yield* Effect.sleep("10 millis")
  const inputs: Record<string, string> = {}
  if (method.prompts) {
    for (const prompt of method.prompts) {
      if (prompt.when) {
        const value = inputs[prompt.when.key]
        if (value === undefined) continue
        const matches = prompt.when.op === "eq" ? value === prompt.when.value : value !== prompt.when.value
        if (!matches) continue
      }
      if (prompt.condition && !prompt.condition(inputs)) continue
      if (prompt.type === "select") {
        if (!process.stdin.isTTY) {
          return yield* fail(`Non-interactive login does not support prompt "${prompt.message}"`)
        }
        const value = yield* Prompt.select({
          message: prompt.message,
          options: prompt.options,
        })
        inputs[prompt.key] = yield* promptValue(value)
        continue
      }
      if (!process.stdin.isTTY) {
        return yield* fail(`Non-interactive login does not support prompt "${prompt.message}"`)
      }
      const value = yield* Prompt.text({
        message: prompt.message,
        placeholder: prompt.placeholder,
        validate: prompt.validate ? (v) => prompt.validate!(v ?? "") : undefined,
      })
      inputs[prompt.key] = yield* promptValue(value)
    }
  }

  if (method.type === "oauth") {
    const authorize = yield* cliTry("Failed to authorize: ", () => method.authorize(inputs))

    if (authorize.url) {
      yield* Prompt.log.info("Go to: " + authorize.url)
    }

    if (authorize.method === "auto") {
      if (authorize.instructions) {
        yield* Prompt.log.info(authorize.instructions)
      }
      const spinner = Prompt.spinner()
      yield* spinner.start("Waiting for authorization...")
      const result = yield* cliTry("Failed to authorize: ", () => authorize.callback())
      if (result.type === "failed") {
        yield* spinner.stop("Failed to authorize", 1)
      }
      if (result.type === "success") {
        const saveProvider = result.provider ?? provider
        if ("refresh" in result) {
          const { type: _, provider: __, refresh, access, expires, ...extraFields } = result
          yield* put(saveProvider, {
            type: "oauth",
            refresh,
            access,
            expires,
            ...extraFields,
          })
        }
        if ("key" in result) {
          yield* put(saveProvider, {
            type: "api",
            key: result.key,
            ...(result.metadata ? { metadata: result.metadata } : {}),
          })
        }
        yield* spinner.stop("Login successful")
      }
    }

    if (authorize.method === "code") {
      const code = yield* Prompt.text({
        message: "Paste the authorization code here: ",
        validate: (x) => (x && x.length > 0 ? undefined : "Required"),
      })
      const authorizationCode = yield* promptValue(code)
      const result = yield* cliTry("Failed to authorize: ", () => authorize.callback(authorizationCode))
      if (result.type === "failed") {
        yield* Prompt.log.error("Failed to authorize")
      }
      if (result.type === "success") {
        const saveProvider = result.provider ?? provider
        if ("refresh" in result) {
          const { type: _, provider: __, refresh, access, expires, ...extraFields } = result
          yield* put(saveProvider, {
            type: "oauth",
            refresh,
            access,
            expires,
            ...extraFields,
          })
        }
        if ("key" in result) {
          yield* put(saveProvider, {
            type: "api",
            key: result.key,
            ...(result.metadata ? { metadata: result.metadata } : {}),
          })
        }
        yield* Prompt.log.success("Login successful")
      }
    }

    yield* Prompt.outro("Done")
    return true
  }

  if (method.type === "api") {
    const apiKey = yield* resolveApiKey(keyArg)

    const metadata = Object.keys(inputs).length ? { metadata: inputs } : {}
    const authorizeApi = method.authorize
    if (!authorizeApi) {
      yield* put(provider, {
        type: "api",
        key: apiKey,
        ...metadata,
      })
      yield* Prompt.outro("Done")
      return true
    }

    const result = yield* cliTry("Failed to authorize: ", () => authorizeApi(inputs))
    if (result.type === "failed") {
      yield* Prompt.log.error("Failed to authorize")
    }
    if (result.type === "success") {
      const saveProvider = result.provider ?? provider
      const merged = { ...(metadata.metadata ?? {}), ...(result.metadata ?? {}) }
      yield* put(saveProvider, {
        type: "api",
        key: result.key ?? apiKey,
        ...(Object.keys(merged).length ? { metadata: merged } : {}),
      })
      yield* Prompt.log.success("Login successful")
    }
    yield* Prompt.outro("Done")
    return true
  }

  return false
})

export function resolvePluginProviders(input: {
  hooks: Hooks[]
  existingProviders: Record<string, unknown>
  disabled: Set<string>
  enabled?: Set<string>
  providerNames: Record<string, string | undefined>
}): Array<{ id: string; name: string }> {
  const seen = new Set<string>()
  const result: Array<{ id: string; name: string }> = []

  for (const hook of input.hooks) {
    if (!hook.auth) continue
    const id = hook.auth.provider
    if (seen.has(id)) continue
    seen.add(id)
    if (Object.hasOwn(input.existingProviders, id)) continue
    if (input.disabled.has(id)) continue
    if (input.enabled && !input.enabled.has(id)) continue
    result.push({
      id,
      name: input.providerNames[id] ?? id,
    })
  }

  return result
}

export const ProvidersCommand = cmd({
  command: "providers",
  aliases: ["auth", "provider"],
  describe: "manage AI providers and credentials",
  builder: (yargs) =>
    yargs
      .command(ProvidersListCommand)
      .command(ProvidersShowCommand)
      .command(ProvidersLoginCommand)
      .command(ProvidersLogoutCommand)
      .command(ProvidersEnableCommand)
      .command(ProvidersDisableCommand)
      .demandCommand(),
  async handler() {},
})

export const ProvidersListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list providers and credentials",
  // Lists global credentials + provider env vars, plus each authed provider's
  // entitled models via Provider.Service.list() (needs config/instance).
  instance: true,
  builder: (yargs) =>
    yargs
      .option("json", {
        type: "boolean",
        describe: "output as JSON (machine-readable; suppresses human output)",
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write providers list to output file path",
      })
      .option("search", {
        alias: ["q", "query"],
        type: "string",
        describe: "filter providers by ID or name substring",
      })
      .option("all", {
        alias: "a",
        type: "boolean",
        describe: "list all known providers in catalog, not only authenticated ones",
      }),
  handler: Effect.fn("Cli.providers.list")(function* (args: {
    json?: boolean
    output?: string
    search?: string
    all?: boolean
  }) {
    const authSvc = yield* Auth.Service
    const modelsDev = yield* ModelsDev.Service
    const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
    const providerSvc = yield* Provider.Service

    const providers = yield* providerSvc.list()
    const database = yield* modelsDev.get()
    const results = Object.entries(yield* Effect.orDie(authSvc.all()))

    const authPath = path.join(Global.Path.data, "auth.json")
    const homedir = os.homedir()
    const displayPath = authPath.startsWith(homedir) ? authPath.replace(homedir, "~") : authPath

    const activeEnvVars: Array<{ providerID: string; name: string; envVar: string }> = []
    for (const [providerID, provider] of Object.entries(database)) {
      for (const envVar of provider.env) {
        if (process.env[envVar]) {
          activeEnvVars.push({ providerID, name: provider.name || providerID, envVar })
        }
      }
    }

    // Real entitled models for a provider, from the same source as `models`.
    const modelsFor = (providerID: string) => {
      const info = providers[ProviderV2.ID.make(providerID)]
      if (!info) return []
      return Object.entries(info.models)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([modelID, model]) => ({
          id: `${providerID}/${modelID}`,
          variants: Object.keys(model.variants ?? {}),
        }))
    }

    const authIDs = new Set(results.map(([id]) => id))

    const query = args.search?.trim().toLowerCase()
    const matchSearch = (id: string, name?: string) => {
      if (!query) return true
      return id.toLowerCase().includes(query) || (name ? name.toLowerCase().includes(query) : false)
    }

    const filteredCreds = results.filter(([id]) => matchSearch(id, database[id]?.name))
    const filteredEnvOnly = activeEnvVars
      .filter((e) => !authIDs.has(e.providerID))
      .filter((e) => matchSearch(e.providerID, e.name))

    const catalogExtras: Array<{ providerID: string; name: string; env: readonly string[] }> = []
    if (args.all) {
      const activeEnvSet = new Set(activeEnvVars.map((e) => e.providerID))
      for (const [id, pDef] of Object.entries(database)) {
        if (!authIDs.has(id) && !activeEnvSet.has(id) && matchSearch(id, pDef.name)) {
          catalogExtras.push({ providerID: id, name: pDef.name || id, env: pDef.env })
        }
      }
      catalogExtras.sort((a, b) => a.name.localeCompare(b.name))
    }

    if (args.json) {
      const out = {
        credentials_path: displayPath,
        providers: [
          ...filteredCreds.map(([id, result]) => ({
            id,
            name: database[id]?.name || id,
            type: result.type,
            source: "auth" as const,
            authenticated: true,
            models: modelsFor(id),
          })),
          ...filteredEnvOnly.map((e) => ({
            id: e.providerID,
            name: database[e.providerID]?.name,
            type: "env" as const,
            source: "env" as const,
            authenticated: true,
            envVar: e.envVar,
            models: modelsFor(e.providerID),
          })),
          ...(args.all
            ? catalogExtras.map((e) => ({
                id: e.providerID,
                name: e.name,
                type: "catalog" as const,
                source: "catalog" as const,
                authenticated: false,
                env: e.env,
                models: [],
              }))
            : []),
        ],
      }
      const jsonStr = JSON.stringify(out, null, 2) + "\n"
      if (args.output) {
        const resolved = path.resolve(args.output)
        yield* Effect.promise(async () => {
          const fs = await import("fs/promises")
          await fs.mkdir(path.dirname(resolved), { recursive: true })
          await fs.writeFile(resolved, jsonStr, "utf-8")
        })
        UI.println(`Wrote providers list to ${resolved}`)
        return
      }
      process.stdout.write(jsonStr)
      return
    }

    if (args.output) {
      const lines: string[] = []
      lines.push(`Credentials ${displayPath}`)
      for (const [providerID, result] of filteredCreds) {
        const name = database[providerID]?.name || providerID
        lines.push(`${name} (${result.type})`)
        const models = modelsFor(providerID)
        if (models.length === 0) lines.push("    (no models)")
        else for (const model of models) lines.push(`    ${model.id}`)
      }
      lines.push(`${filteredCreds.length} credentials`)
      if (filteredEnvOnly.length > 0) {
        lines.push("")
        lines.push("Environment")
        for (const { providerID, name, envVar } of filteredEnvOnly) {
          lines.push(`${name} (${envVar})`)
          const models = modelsFor(providerID)
          if (models.length === 0) lines.push("    (no models)")
          else for (const model of models) lines.push(`    ${model.id}`)
        }
        lines.push(`${filteredEnvOnly.length} environment variable` + (filteredEnvOnly.length === 1 ? "" : "s"))
      }
      if (catalogExtras.length > 0) {
        lines.push("")
        lines.push("Other Catalog Providers (unauthenticated)")
        for (const { providerID, name, env } of catalogExtras) {
          lines.push(`${name} (${providerID}) - env: ${env.join(", ") || "(none)"}`)
        }
        lines.push(`${catalogExtras.length} catalog providers`)
      }
      const resolved = path.resolve(args.output)
      yield* Effect.promise(async () => {
        const fs = await import("fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        await fs.writeFile(resolved, lines.join("\n") + "\n", "utf-8")
      })
      UI.println(`Wrote providers list to ${resolved}`)
      return
    }

    const printModels = (providerID: string) =>
      Effect.gen(function* () {
        const models = modelsFor(providerID)
        if (models.length === 0) return yield* Prompt.log.info(`    (no models)`)
        for (const model of models) yield* Prompt.log.info(`    ${model.id}`)
      })

    UI.empty()
    yield* Prompt.intro(`Credentials ${UI.Style.TEXT_DIM}${displayPath}`)

    for (const [providerID, result] of filteredCreds) {
      const name = database[providerID]?.name || providerID
      yield* Prompt.log.info(`${name} ${UI.Style.TEXT_DIM}${result.type}`)
      yield* printModels(providerID)
    }

    yield* Prompt.outro(`${filteredCreds.length} credentials`)

    // auth wins on overlap: only list providers that are env-only here.
    if (filteredEnvOnly.length > 0) {
      UI.empty()
      yield* Prompt.intro("Environment")

      for (const { providerID, name, envVar } of filteredEnvOnly) {
        yield* Prompt.log.info(`${name} ${UI.Style.TEXT_DIM}${envVar}`)
        yield* printModels(providerID)
      }

      yield* Prompt.outro(`${filteredEnvOnly.length} environment variable` + (filteredEnvOnly.length === 1 ? "" : "s"))
    }

    if (catalogExtras.length > 0) {
      UI.empty()
      yield* Prompt.intro("Other Catalog Providers (unauthenticated)")
      for (const { providerID, name, env } of catalogExtras) {
        const envHint = env.length > 0 ? ` ${UI.Style.TEXT_DIM}[${env.join(", ")}]` : ""
        yield* Prompt.log.info(`${name} ${UI.Style.TEXT_DIM}(${providerID})${envHint}`)
      }
      yield* Prompt.outro(`${catalogExtras.length} catalog providers`)
    }
  }),
})

export const providersShow = Effect.fn("Cli.providers.show")(function* (args: {
  provider: string
  json?: boolean
  output?: string
}) {
  const authSvc = yield* Auth.Service
  const modelsDev = yield* ModelsDev.Service
  const database = yield* modelsDev.get()
  const allCreds = yield* Effect.orDie(authSvc.all())
  const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
  const providerSvc = yield* Provider.Service
  const providers = yield* providerSvc.list()

  const inputID = args.provider.trim()
  let providerID = inputID
  if (!database[providerID]) {
    const lower = inputID.toLowerCase()
    for (const [id, entry] of Object.entries(database)) {
      if (id.toLowerCase() === lower || entry.name?.toLowerCase() === lower) {
        providerID = id
        break
      }
    }
  }

  const catalogEntry = database[providerID]
  const cred = allCreds[providerID]
  const activeEnv = catalogEntry ? catalogEntry.env.filter((e) => Boolean(process.env[e])) : []
  const isAuthed = Boolean(cred) || activeEnv.length > 0 || providerID === "ollama"

  // Check config status (disabled/enabled)
  const effectiveCfg = yield* Config.Service.use((cfg) => cfg.get())
  const isDisabled = effectiveCfg.disabled_providers?.includes(providerID) ?? false
  const status = isDisabled ? "disabled" : "enabled"

  // Models for this provider
  const pInfo = providers[ProviderV2.ID.make(providerID)]
  const models = pInfo
    ? Object.entries(pInfo.models)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([modelID, m]) => ({
          id: `${providerID}/${modelID}`,
          name: m.name,
          variants: Object.keys(m.variants ?? {}),
        }))
    : []

  if (!catalogEntry && !cred && !pInfo) {
    return yield* fail(`Unknown provider "${args.provider}"`)
  }

  const authPath = path.join(Global.Path.data, "auth.json")
  const homedir = os.homedir()
  const displayPath = authPath.startsWith(homedir) ? authPath.replace(homedir, "~") : authPath

  const providerConfig = effectiveCfg.provider?.[providerID]

  const authSource =
    cred && activeEnv.length > 0
      ? "both"
      : cred
        ? "credentials"
        : activeEnv.length > 0
          ? "environment"
          : providerID === "ollama"
            ? "local"
            : "none"

  if (args.json) {
    const out = {
      id: providerID,
      name: catalogEntry?.name || providerID,
      authenticated: isAuthed,
      auth_source: authSource,
      credentials: cred ? { type: cred.type, path: displayPath } : null,
      environment: activeEnv,
      status,
      config: providerConfig ?? {},
      models_count: models.length,
      models,
    }
    const jsonStr = JSON.stringify(out, null, 2) + "\n"
    if (args.output) {
      const resolved = path.resolve(args.output)
      yield* Effect.promise(async () => {
        const fs = await import("fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        await fs.writeFile(resolved, jsonStr, "utf-8")
      })
      UI.println(`Wrote provider details to ${resolved}`)
      return
    }
    process.stdout.write(jsonStr)
    return
  }

  if (args.output) {
    const displayName = catalogEntry?.name || providerID
    const lines: string[] = [
      `${displayName} (${providerID})`,
      `Status: ${status}`,
      `Authenticated: ${isAuthed ? "yes" : "no"}`,
    ]
    if (cred) lines.push(`Credential: ${cred.type} (${displayPath})`)
    if (activeEnv.length > 0) lines.push(`Active Environment: ${activeEnv.join(", ")}`)
    else if (catalogEntry && catalogEntry.env.length > 0 && !cred) {
      lines.push(`Environment: (none - supported: ${catalogEntry.env.join(", ")})`)
    }
    if (providerConfig && Object.keys(providerConfig).length > 0) {
      lines.push(`Config options: ${JSON.stringify(providerConfig)}`)
    }
    lines.push(`Models (${models.length}):`)
    if (models.length === 0) {
      if (!isAuthed) {
        lines.push(`    (not authenticated; log in with: lmplayer auth login --provider ${providerID})`)
      } else {
        lines.push(`    (no models available)`)
      }
    } else {
      for (const m of models) {
        const variantsText = m.variants.length > 0 ? ` [variants: ${m.variants.join(", ")}]` : ""
        lines.push(`    ${m.id}${variantsText}`)
      }
    }
    const resolved = path.resolve(args.output)
    yield* Effect.promise(async () => {
      const fs = await import("fs/promises")
      await fs.mkdir(path.dirname(resolved), { recursive: true })
      await fs.writeFile(resolved, lines.join("\n") + "\n", "utf-8")
    })
    UI.println(`Wrote provider details to ${resolved}`)
    return
  }

  UI.empty()
  const displayName = catalogEntry?.name || providerID
  yield* Prompt.intro(`${displayName} ${UI.Style.TEXT_DIM}(${providerID})`)
  yield* Prompt.log.info(
    `Status: ${status === "enabled" ? UI.Style.TEXT_SUCCESS + "enabled" + UI.Style.TEXT_NORMAL : UI.Style.TEXT_DANGER + "disabled" + UI.Style.TEXT_NORMAL}`,
  )
  yield* Prompt.log.info(`Authenticated: ${isAuthed ? "yes" : "no"}`)
  if (cred) {
    yield* Prompt.log.info(`Credential: ${cred.type} (${displayPath})`)
  }
  if (activeEnv.length > 0) {
    yield* Prompt.log.info(`Active Environment: ${activeEnv.join(", ")}`)
  } else if (catalogEntry && catalogEntry.env.length > 0 && !cred) {
    yield* Prompt.log.info(`Environment: (none - supported: ${catalogEntry.env.join(", ")})`)
  }
  if (providerConfig && Object.keys(providerConfig).length > 0) {
    yield* Prompt.log.info(`Config options: ${JSON.stringify(providerConfig)}`)
  }
  yield* Prompt.log.info(`Models (${models.length}):`)
  if (models.length === 0) {
    if (!isAuthed) {
      yield* Prompt.log.info(`    (not authenticated; log in with: lmplayer auth login --provider ${providerID})`)
    } else {
      yield* Prompt.log.info(`    (no models available)`)
    }
  } else {
    for (const m of models) {
      const variantsText = m.variants.length > 0 ? ` ${UI.Style.TEXT_DIM}[variants: ${m.variants.join(", ")}]` : ""
      yield* Prompt.log.info(`    ${m.id}${variantsText}`)
    }
  }
  yield* Prompt.outro("Done")
})

export const ProvidersShowCommand = effectCmd({
  command: "show <provider>",
  aliases: ["get"],
  describe: "show detailed information for an AI provider",
  instance: true,
  builder: (yargs) =>
    yargs
      .positional("provider", {
        describe: "provider ID or name to show",
        type: "string",
        demandOption: true,
      })
      .option("json", {
        describe: "output as JSON",
        type: "boolean",
      })
      .option("output", {
        alias: "o",
        describe: "write provider details to output file path",
        type: "string",
      }),
  handler: Effect.fn("Cli.providers.show.cmd")(function* (args: {
    provider: string
    json?: boolean
    output?: string
  }) {
    yield* providersShow({
      provider: args.provider!,
      json: Boolean(args.json),
      output: args.output,
    })
  }),
})

export const ProvidersLoginCommand = effectCmd({
  command: "login [url]",
  describe: "log in to a provider",
  // URL login skips instance bootstrap, which would load remote config with the stale token and crash before re-auth.
  instance: (args) => !args.url,
  builder: (yargs: Argv) =>
    yargs
      .positional("url", {
        describe: "auth provider URL or ID",
        type: "string",
      })
      .option("provider", {
        alias: ["p"],
        describe: "provider id or name to log in to (skips provider selection)",
        type: "string",
      })
      .option("method", {
        alias: ["m"],
        describe: "login method label (skips method selection)",
        type: "string",
      })
      .option("key", {
        alias: ["api-key", "k"],
        describe: "API key (non-interactive; use '-' to read from stdin)",
        type: "string",
      })
      .option("output", {
        alias: "o",
        describe: "write login result to output file path",
        type: "string",
      })
      .option("json", {
        describe: "output as JSON",
        type: "boolean",
        default: false,
      }),
  handler: Effect.fn("Cli.providers.login")(function* (args: {
    url?: string
    provider?: string
    method?: string
    key?: string
    output?: string
    json?: boolean
  }) {
    const authSvc = yield* Auth.Service

    if (!args.json) {
      UI.empty()
      yield* Prompt.intro("Add credential")
    }
    if (args.url) {
      const url = args.url.replace(/\/+$/, "")
      const wellknown = (yield* cliTry(`Failed to load auth provider metadata from ${url}: `, () =>
        fetch(`${url}/.well-known/opencode`).then((x) => x.json()),
      )) as {
        auth: { command: string[]; env: string }
      }
      yield* Prompt.log.info(`Running \`${wellknown.auth.command.join(" ")}\``)
      const abort = new AbortController()
      const proc = Process.spawn(wellknown.auth.command, { stdout: "pipe", stderr: "inherit", abort: abort.signal })
      if (!proc.stdout) {
        yield* Prompt.log.error("Failed")
        yield* Prompt.outro("Done")
        return
      }
      const [exit, token] = yield* cliTry("Failed to run auth provider command: ", () =>
        Promise.all([proc.exited, text(proc.stdout!)]),
      ).pipe(Effect.ensuring(Effect.sync(() => abort.abort())))
      if (exit !== 0) {
        yield* Prompt.log.error("Failed")
        yield* Prompt.outro("Done")
        return
      }
      yield* Effect.orDie(authSvc.set(url, { type: "wellknown", key: wellknown.auth.env, token: token.trim() }))
      yield* Prompt.log.success("Logged into " + url)
      yield* Prompt.outro("Done")
      return
    }

    const cfgSvc = yield* Config.Service
    const pluginSvc = yield* Plugin.Service
    const modelsDev = yield* ModelsDev.Service
    yield* Effect.ignore(modelsDev.refresh(true))

    const config = yield* cfgSvc.get()

    const disabled = new Set(config.disabled_providers ?? [])
    const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined

    const allProviders = yield* modelsDev.get()
    const providers: Record<string, (typeof allProviders)[string]> = {}
    for (const [key, value] of Object.entries(allProviders)) {
      if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) providers[key] = value
    }
    const hooks = yield* pluginSvc.list()

    const priority: Record<string, number> = {
      opencode: 0,
      openai: 1,
      "github-copilot": 2,
      google: 3,
      anthropic: 4,
      openrouter: 5,
      vercel: 6,
    }
    const pluginProviders = resolvePluginProviders({
      hooks,
      existingProviders: providers,
      disabled,
      enabled,
      providerNames: Object.fromEntries(Object.entries(config.provider ?? {}).map(([id, p]) => [id, p.name])),
    })
    const options = [
      ...pipe(
        providers,
        values(),
        sortBy(
          (x) => priority[x.id] ?? 99,
          (x) => x.name ?? x.id,
        ),
        map((x) => ({
          label: x.name,
          value: x.id,
          hint: {
            opencode: "recommended",
            openai: "ChatGPT Plus/Pro or API key",
          }[x.id],
        })),
      ),
      ...pluginProviders.map((x) => ({
        label: x.name,
        value: x.id,
        hint: "plugin",
      })),
    ]

    let provider: string
    if (args.provider) {
      const input = args.provider
      const byID = options.find((x) => x.value === input)
      const byName = options.find((x) => x.label.toLowerCase() === input.toLowerCase())
      const byConfig = config.provider?.[input]
        ? { label: config.provider[input].name ?? input, value: input }
        : undefined
      const match = byID ?? byName ?? byConfig
      if (!match) {
        return yield* fail(`Unknown provider "${input}"`)
      }
      provider = match.value
    } else {
      if (!process.stdin.isTTY) {
        return yield* fail("Provider is required when running non-interactively. Supply --provider <name>.")
      }
      provider = yield* promptValue(
        yield* Prompt.autocomplete({
          message: "Select provider",
          maxItems: 8,
          options: [...options, { value: "other", label: "Other" }],
        }),
      )
    }

    const plugin = hooks.findLast((x) => x.auth?.provider === provider)
    if (plugin && plugin.auth) {
      const handled = yield* handlePluginAuth({ auth: plugin.auth! }, provider, args.method, args.key)
      if (handled) {
        if (args.output || args.json) {
          const resultPayload = { ok: true, provider, authenticated: true }
          const jsonStr = JSON.stringify(resultPayload, null, 2) + "\n"
          if (args.output) {
            const resolved = path.resolve(args.output)
            yield* Effect.promise(async () => {
              const fs = await import("fs/promises")
              await fs.mkdir(path.dirname(resolved), { recursive: true })
              await fs.writeFile(resolved, args.json ? jsonStr : `Logged into ${provider}\n`, "utf-8")
            })
            UI.println(`Wrote login result to ${resolved}`)
          }
          if (args.json) {
            process.stdout.write(jsonStr)
          }
        }
        return
      }
    }

    if (provider === "other") {
      if (!process.stdin.isTTY) {
        return yield* fail(
          "Provider 'other' interactive selection is not supported in non-interactive mode. Specify the provider name directly with --provider.",
        )
      }
      provider = (yield* promptValue(
        yield* Prompt.text({
          message: "Enter provider id",
          validate: (x) => (x && x.match(/^[0-9a-z-]+$/) ? undefined : "a-z, 0-9 and hyphens only"),
        }),
      )).replace(/^@ai-sdk\//, "")

      const customPlugin = hooks.findLast((x) => x.auth?.provider === provider)
      if (customPlugin && customPlugin.auth) {
        const handled = yield* handlePluginAuth({ auth: customPlugin.auth! }, provider, args.method, args.key)
        if (handled) {
          if (args.output || args.json) {
            const resultPayload = { ok: true, provider, authenticated: true }
            const jsonStr = JSON.stringify(resultPayload, null, 2) + "\n"
            if (args.output) {
              const resolved = path.resolve(args.output)
              yield* Effect.promise(async () => {
                const fs = await import("fs/promises")
                await fs.mkdir(path.dirname(resolved), { recursive: true })
                await fs.writeFile(resolved, args.json ? jsonStr : `Logged into ${provider}\n`, "utf-8")
              })
              UI.println(`Wrote login result to ${resolved}`)
            }
            if (args.json) {
              process.stdout.write(jsonStr)
            }
          }
          return
        }
      }

      yield* Prompt.log.warn(
        `This only stores a credential for ${provider} - you will need configure it in opencode.json, check the docs for examples.`,
      )
    }

    if (provider === "amazon-bedrock") {
      yield* Prompt.log.info(
        "Amazon Bedrock authentication priority:\n" +
          "  1. Bearer token (AWS_BEARER_TOKEN_BEDROCK or /connect)\n" +
          "  2. AWS credential chain (profile, access keys, IAM roles, EKS IRSA)\n\n" +
          "Configure via opencode.json options (profile, region, endpoint) or\n" +
          "AWS environment variables (AWS_PROFILE, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_WEB_IDENTITY_TOKEN_FILE).",
      )
    }

    if (provider === "opencode") {
      yield* Prompt.log.info("Create an api key at https://opencode.ai/auth")
    }

    if (provider === "vercel") {
      yield* Prompt.log.info("You can create an api key at https://vercel.link/ai-gateway-token")
    }

    if (["cloudflare", "cloudflare-ai-gateway"].includes(provider)) {
      yield* Prompt.log.info(
        "Cloudflare AI Gateway can be configured with CLOUDFLARE_GATEWAY_ID, CLOUDFLARE_ACCOUNT_ID, and CLOUDFLARE_API_TOKEN environment variables. Read more: https://opencode.ai/docs/providers/#cloudflare-ai-gateway",
      )
    }

    const apiKey = yield* resolveApiKey(args.key)
    yield* Effect.orDie(authSvc.set(provider, { type: "api", key: apiKey }))

    const resultPayload = {
      ok: true,
      provider,
      authenticated: true,
    }
    const jsonStr = JSON.stringify(resultPayload, null, 2) + "\n"
    const textStr = `Logged into ${provider}\n`

    if (args.output) {
      const resolved = path.resolve(args.output)
      yield* Effect.promise(async () => {
        const fs = await import("fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        await fs.writeFile(resolved, args.json ? jsonStr : textStr, "utf-8")
      })
      UI.println(`Wrote login result to ${resolved}`)
    }

    if (args.json) {
      process.stdout.write(jsonStr)
      return
    }

    yield* Prompt.log.success(`Logged into ${provider}`)
    yield* Prompt.outro("Done")
  }),
})

export const ProvidersLogoutCommand = effectCmd({
  command: "logout [provider]",
  describe: "log out from a configured provider",
  builder: (yargs) =>
    yargs
      .positional("provider", {
        describe: "provider id or name to log out from",
        type: "string",
      })
      .option("force", {
        alias: "f",
        describe: "do not exit non-zero if provider credential is not found",
        type: "boolean",
      })
      .option("json", {
        describe: "output JSON result",
        type: "boolean",
      })
      .option("output", {
        alias: "o",
        describe: "write logout result to output file path",
        type: "string",
      }),
  // Removes a global auth credential; no project instance needed.
  instance: false,
  handler: Effect.fn("Cli.providers.logout")(function* (args: {
    provider?: string
    force?: boolean
    json?: boolean
    output?: string
  }) {
    const authSvc = yield* Auth.Service
    const modelsDev = yield* ModelsDev.Service

    if (!args.provider && !process.stdin.isTTY) {
      if (args.json) {
        const payload = { ok: false, error: "Provider name or ID is required in non-interactive mode" }
        const jsonStr = JSON.stringify(payload, null, 2) + "\n"
        if (args.output) {
          const resolved = path.resolve(args.output)
          yield* Effect.promise(async () => {
            const fs = await import("fs/promises")
            await fs.mkdir(path.dirname(resolved), { recursive: true })
            await fs.writeFile(resolved, jsonStr, "utf-8")
          })
        }
        process.stdout.write(jsonStr)
        if (!args.force) process.exitCode = 1
        return
      }
      return yield* fail("Provider name or ID is required in non-interactive mode. Specify a provider ID or name.")
    }

    const credentials: Array<[string, Auth.Info]> = Object.entries(yield* Effect.orDie(authSvc.all()))
    if (credentials.length === 0) {
      if (args.force) {
        if (args.json) {
          const payload = { ok: true, provider: args.provider, removed: false, message: "No credentials found" }
          const jsonStr = JSON.stringify(payload, null, 2) + "\n"
          if (args.output) {
            const resolved = path.resolve(args.output)
            yield* Effect.promise(async () => {
              const fs = await import("fs/promises")
              await fs.mkdir(path.dirname(resolved), { recursive: true })
              await fs.writeFile(resolved, jsonStr, "utf-8")
            })
          }
          process.stdout.write(jsonStr)
          return
        }
        if (args.output) {
          const resolved = path.resolve(args.output)
          yield* Effect.promise(async () => {
            const fs = await import("fs/promises")
            await fs.mkdir(path.dirname(resolved), { recursive: true })
            await fs.writeFile(resolved, "No credentials found\n", "utf-8")
          })
        }
        UI.println("No credentials found")
        return
      }
      if (args.json) {
        const payload = { ok: false, error: "No credentials found" }
        const jsonStr = JSON.stringify(payload, null, 2) + "\n"
        if (args.output) {
          const resolved = path.resolve(args.output)
          yield* Effect.promise(async () => {
            const fs = await import("fs/promises")
            await fs.mkdir(path.dirname(resolved), { recursive: true })
            await fs.writeFile(resolved, jsonStr, "utf-8")
          })
        }
        process.stdout.write(jsonStr)
        process.exitCode = 1
        return
      }
      UI.empty()
      yield* Prompt.intro("Remove credential")
      yield* Prompt.log.error("No credentials found")
      process.exitCode = 1
      return
    }

    const database = yield* modelsDev.get()
    const options = credentials.map(([key, value]) => ({
      label: (database[key]?.name || key) + UI.Style.TEXT_DIM + " (" + value.type + ")",
      value: key,
    }))
    const provider = args.provider
      ? options.find(
          (option) =>
            option.value === args.provider ||
            database[option.value]?.name?.toLowerCase() === args.provider?.toLowerCase(),
        )?.value
      : yield* promptValue(
          yield* Prompt.autocomplete({
            message: "Select provider",
            maxItems: 8,
            options,
          }),
        )

    if (!provider) {
      if (args.force) {
        if (args.json) {
          const payload = { ok: true, provider: args.provider, removed: false }
          const jsonStr = JSON.stringify(payload, null, 2) + "\n"
          if (args.output) {
            const resolved = path.resolve(args.output)
            yield* Effect.promise(async () => {
              const fs = await import("fs/promises")
              await fs.mkdir(path.dirname(resolved), { recursive: true })
              await fs.writeFile(resolved, jsonStr, "utf-8")
            })
          }
          process.stdout.write(jsonStr)
          return
        }
        if (args.output) {
          const resolved = path.resolve(args.output)
          yield* Effect.promise(async () => {
            const fs = await import("fs/promises")
            await fs.mkdir(path.dirname(resolved), { recursive: true })
            await fs.writeFile(resolved, `Provider "${args.provider}" was not logged in\n`, "utf-8")
          })
        }
        UI.println(`Provider "${args.provider}" was not logged in`)
        return
      }
      if (args.json) {
        const payload = { ok: false, error: `Unknown configured provider "${args.provider}"` }
        const jsonStr = JSON.stringify(payload, null, 2) + "\n"
        if (args.output) {
          const resolved = path.resolve(args.output)
          yield* Effect.promise(async () => {
            const fs = await import("fs/promises")
            await fs.mkdir(path.dirname(resolved), { recursive: true })
            await fs.writeFile(resolved, jsonStr, "utf-8")
          })
        }
        process.stdout.write(jsonStr)
        process.exitCode = 1
        return
      }
      return yield* fail(`Unknown configured provider "${args.provider}"`)
    }

    yield* Effect.orDie(authSvc.remove(provider))
    if (args.json) {
      const payload = { ok: true, provider, removed: true }
      const jsonStr = JSON.stringify(payload, null, 2) + "\n"
      if (args.output) {
        const resolved = path.resolve(args.output)
        yield* Effect.promise(async () => {
          const fs = await import("fs/promises")
          await fs.mkdir(path.dirname(resolved), { recursive: true })
          await fs.writeFile(resolved, jsonStr, "utf-8")
        })
      }
      process.stdout.write(jsonStr)
      return
    }

    if (args.output) {
      const resolved = path.resolve(args.output)
      yield* Effect.promise(async () => {
        const fs = await import("fs/promises")
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        await fs.writeFile(resolved, `Logout successful: ${provider}\n`, "utf-8")
      })
    }
    UI.empty()
    yield* Prompt.intro("Remove credential")
    yield* Prompt.outro("Logout successful")
  }),
})

const addProviderScopeOptions = <T>(yargs: Argv<T>) =>
  yargs
    .option("scope", {
      describe: "configuration target scope (project or global)",
      choices: ["project", "global"] as const,
      type: "string",
    })
    .option("global", {
      alias: ["g"],
      describe: "target global configuration (equivalent to --scope global)",
      type: "boolean",
    })
    .option("project", {
      alias: ["p"],
      describe: "target project configuration (equivalent to --scope project)",
      type: "boolean",
    })
    .check((argv) => {
      if (argv.project && argv.global) {
        throw new Error("Cannot specify both global and project scope")
      }
      if (argv.scope && (argv.project || argv.global)) {
        throw new Error("Cannot specify both --scope and --project/--global")
      }
      return true
    })

const makeProviderToggleCommand = (action: "enable" | "disable") =>
  effectCmd({
    command: `${action} <provider>`,
    describe: `${action} an AI provider`,
    builder: (yargs) =>
      addProviderScopeOptions(
        yargs.positional("provider", {
          describe: `provider ID or name to ${action}`,
          type: "string",
          demandOption: true,
        }),
      )
        .option("json", {
          type: "boolean",
          describe: "output JSON",
        })
        .option("output", {
          alias: "o",
          type: "string",
          describe: `write ${action} result to output file path`,
        }),
    handler: Effect.fn(`Cli.providers.${action}`)(function* (args: {
      provider: string
      global?: boolean
      project?: boolean
      scope?: "project" | "global"
      json?: boolean
      output?: string
    }) {
      const modelsDev = yield* ModelsDev.Service
      const database = yield* modelsDev.get()
      const isProject = Boolean(args.project || args.scope === "project")

      let providerID = args.provider
      if (!database[providerID]) {
        const lower = providerID.toLowerCase()
        for (const [id, entry] of Object.entries(database)) {
          if (id.toLowerCase() === lower || entry.name?.toLowerCase() === lower) {
            providerID = id
            break
          }
        }
      }

      const current = yield* Config.Service.use((cfg) =>
        isProject ? cfg.getProject() : cfg.getGlobal(),
      )

      let disabled = [...(current.disabled_providers ?? [])]
      let enabled = current.enabled_providers !== undefined ? [...current.enabled_providers] : undefined

      if (action === "disable") {
        if (!disabled.includes(providerID)) {
          disabled.push(providerID)
        }
        if (enabled !== undefined) {
          enabled = enabled.filter((p) => p !== providerID)
        }
      } else {
        disabled = disabled.filter((p) => p !== providerID)
        if (enabled !== undefined && !enabled.includes(providerID)) {
          enabled.push(providerID)
        }
      }

      const patch: ConfigV1.Info = {
        disabled_providers: disabled,
        ...(enabled !== undefined ? { enabled_providers: enabled } : {}),
      }

      let configFilePath: string | undefined
      if (isProject) {
        const res = yield* Config.Service.use((cfg) => cfg.updateProject(patch))
        configFilePath = res.file
      } else {
        yield* Config.Service.use((cfg) => cfg.updateGlobal(patch))
      }

      const summaryPayload = {
        ok: true,
        provider: providerID,
        action,
        enabled: action === "enable",
        scope: isProject ? "project" : "global",
        ...(configFilePath ? { file: configFilePath } : {}),
      }
      const summaryText = `Provider "${providerID}" ${action}d in ${isProject ? "project" : "global"} configuration${configFilePath ? ` (${configFilePath})` : ""}`

      if (args.output) {
        const resolved = path.resolve(args.output)
        yield* Effect.promise(async () => {
          const fs = await import("fs/promises")
          await fs.mkdir(path.dirname(resolved), { recursive: true })
          if (args.json) {
            await fs.writeFile(resolved, JSON.stringify(summaryPayload, null, 2) + os.EOL, "utf-8")
          } else {
            await fs.writeFile(resolved, summaryText + os.EOL, "utf-8")
          }
        })
        UI.println(`Wrote ${action} result to ${resolved}`)
        return
      }

      if (args.json) {
        process.stdout.write(JSON.stringify(summaryPayload, null, 2) + os.EOL)
        return
      }

      yield* Prompt.log.success(summaryText)
    }),
  })

export const ProvidersEnableCommand = makeProviderToggleCommand("enable")
export const ProvidersDisableCommand = makeProviderToggleCommand("disable")

