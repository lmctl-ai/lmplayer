import { EOL } from "os"
import { Effect } from "effect"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { ProviderV2 } from "@opencode-ai/core/provider"

export const ModelsCommand = effectCmd({
  command: "models [provider]",
  describe: "list all available models",
  builder: (yargs) =>
    yargs
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
      }),
  handler: Effect.fn("Cli.models")(function* (args) {
    const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
    if (args.refresh) {
      yield* ModelsDev.Service.use((s) => s.refresh(true))
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + "Models cache refreshed" + UI.Style.TEXT_NORMAL)
    }

    const provider = yield* Provider.Service
    const providers = yield* provider.list()

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
        .map(([modelID, model]) => ({
          id: `${providerID}/${modelID}`,
          provider: providerID as string,
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
        }))
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
