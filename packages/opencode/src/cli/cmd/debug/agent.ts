import { Effect } from "effect"
import { effectCmd } from "../../effect-cmd"

export const AgentCommand = effectCmd({
  command: "agent <name>",
  describe: "show agent configuration details",
  builder: (yargs) =>
    yargs
      .positional("name", {
        type: "string",
        demandOption: true,
        description: "Agent name",
      })
      .option("tool", {
        type: "string",
        description: "Tool id to execute",
      })
      .option("params", {
        type: "string",
        description: "Tool params as JSON or a JS object literal",
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write agent details or tool execution result to output file path",
      })
      .option("json", {
        type: "boolean",
        describe: "output JSON",
        default: false,
      }),
  handler: (args: { name: string; tool?: string; params?: string; output?: string; json?: boolean }) =>
    Effect.gen(function* () {
      const { debugAgent } = yield* Effect.promise(() => import("./agent.handler"))
      return yield* debugAgent(args)
    }),
})
