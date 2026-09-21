import type { CommandModule } from "yargs"
import path from "node:path"
import { UI } from "../ui"

type Args = {
  output?: string
}

export const GenerateCommand = {
  command: "generate",
  builder: (yargs) =>
    yargs.option("output", {
      alias: "o",
      type: "string",
      describe: "write OpenAPI schema to output file path",
    }),
  handler: async (args) => {
    const { Server } = await import("../../server/server")
    const specs = (await Server.openapi()) as {
      paths: Record<string, Record<string, any>>
    }
    for (const item of Object.values(specs.paths)) {
      for (const method of ["get", "post", "put", "delete", "patch"] as const) {
        const operation = item[method]
        if (!operation?.operationId) continue
        operation["x-codeSamples"] = [
          {
            lang: "js",
            source: [
              `import { createOpencodeClient } from "@opencode-ai/sdk`,
              ``,
              `const client = createOpencodeClient()`,
              `await client.${operation.operationId}({`,
              `  ...`,
              `})`,
            ].join("\n"),
          },
        ]
      }
    }
    const raw = JSON.stringify(specs, null, 2)

    // Format through prettier so output is byte-identical to committed file
    // regardless of whether ./script/format.ts runs afterward.
    const prettier = await import("prettier")
    const babel = await import("prettier/plugins/babel")
    const estree = await import("prettier/plugins/estree")
    const format = prettier.format ?? prettier.default?.format
    const json = await format(raw, {
      parser: "json",
      plugins: [babel.default ?? babel, estree.default ?? estree],
      printWidth: 120,
    })

    if (args.output) {
      const resolved = path.resolve(args.output)
      const fs = await import("node:fs/promises")
      await fs.mkdir(path.dirname(resolved), { recursive: true })
      await fs.writeFile(resolved, json, "utf-8")
      UI.println(`Wrote OpenAPI schema to ${resolved}`)
      return
    }

    // Wait for stdout to finish writing before process.exit() is called
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(json, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  },
} satisfies CommandModule<object, Args>
