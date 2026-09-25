import { EOL } from "os"
import path from "node:path"
import { Effect } from "effect"
import { Catalog } from "@opencode-ai/core/catalog"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { effectCmd } from "../../effect-cmd"
import { UI } from "@/cli/ui"

export const V2Command = effectCmd({
  command: "v2",
  describe: "debug v2 catalog and built-in plugins",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write v2 debug info to output file path",
      })
      .option("json", {
        type: "boolean",
        describe: "output JSON",
        default: false,
      }),
  handler: (args: { output?: string; o?: string; json?: boolean }) =>
    Effect.gen(function* () {
      const output = args.output ?? args.o
      const catalog = yield* Catalog.Service
      const providers = (yield* catalog.provider.available()).sort((a, b) => a.id.localeCompare(b.id))
      const all = (yield* catalog.provider.all()).sort((a, b) => a.id.localeCompare(b.id))
      const result = {
        providers,
        default: catalog.model.default().pipe(Effect.map((item) => item?.id)),
        small: Object.fromEntries(
          yield* Effect.all(
            all.map((provider) =>
              Effect.map(catalog.model.small(provider.id), (model) => [provider.id, model?.id] as const),
            ),
            { concurrency: "unbounded" },
          ),
        ),
      }
      const json = JSON.stringify(result, null, 2) + EOL
      if (output) {
        const resolved = path.resolve(output)
        yield* Effect.promise(async () => {
          const fs = await import("node:fs/promises")
          await fs.mkdir(path.dirname(resolved), { recursive: true })
          await fs.writeFile(resolved, json, "utf-8")
        })
        UI.println(`Wrote v2 debug info to ${resolved}`)
        return
      }
      process.stdout.write(json)
    }).pipe(
      Effect.withSpan("Cli.debug.v2"),
      Effect.provide(
        LocationServiceMap.Service.get(
          Location.Ref.make({
            directory: AbsolutePath.make(process.cwd()),
          }),
        ),
      ),
      Effect.provide(locationServiceMapLayer),
    ),
})
