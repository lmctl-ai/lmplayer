import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd } from "../effect-cmd"

export {
  extractResponseText,
  formatPromptTooLargeError,
  parseGitHubRemote,
  generateWorkflowYaml,
  buildGithubInstallResult,
  formatGithubInstallText,
  buildNextSteps,
  getProviderEnv,
  getDefaultModel,
  writeOutputFile,
  WORKFLOW_FILE,
} from "./github.shared"
export type { GenerateWorkflowOptions, GithubInstallResult } from "./github.shared"

export const GithubInstallCommand = effectCmd({
  command: "install",
  describe: "install the GitHub agent",
  builder: (yargs) =>
    yargs
      .option("provider", {
        alias: "p",
        type: "string",
        describe: "model provider (e.g. anthropic, openai, amazon-bedrock)",
      })
      .option("model", {
        alias: "m",
        type: "string",
        describe: "model ID (e.g. claude-sonnet-4-0, gpt-5.4)",
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write workflow YAML or install result to file path",
      })
      .option("dry-run", {
        type: "boolean",
        describe: "preview workflow generation without modifying filesystem",
        default: false,
      })
      .option("skip-app", {
        type: "boolean",
        describe: "skip GitHub app installation and polling",
        default: false,
      })
      .option("force", {
        alias: "f",
        type: "boolean",
        describe: "overwrite existing workflow file if it exists",
        default: false,
      })
      .option("json", {
        type: "boolean",
        describe: "output as JSON",
        default: false,
      }),
  handler: (args) =>
    Effect.gen(function* () {
      const normalizedArgs = {
        ...args,
        provider: args.provider ?? (args as any).p,
        model: args.model ?? (args as any).m,
        output: args.output ?? (args as any).o,
        force: args.force ?? (args as any).f,
      }
      const { githubInstall } = yield* Effect.promise(() => import("./github.handler"))
      return yield* githubInstall(normalizedArgs)
    }),
})

export const GithubRunCommand = effectCmd({
  command: "run",
  describe: "run the GitHub agent",
  builder: (yargs) =>
    yargs
      .option("event", {
        alias: ["e"],
        type: "string",
        describe: "GitHub mock event to run the agent for",
      })
      .option("token", {
        alias: ["t"],
        type: "string",
        describe: "GitHub personal access token (github_pat_********)",
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write run summary to output file path",
      })
      .option("json", {
        type: "boolean",
        describe: "output as JSON",
        default: false,
      }),
  handler: (args: {
    event?: string
    e?: string
    token?: string
    t?: string
    output?: string
    o?: string
    json?: boolean
  }) =>
    Effect.gen(function* () {
      const { githubRun } = yield* Effect.promise(() => import("./github.handler"))
      return yield* githubRun({
        event: args.event ?? (args as any).e,
        token: args.token ?? (args as any).t,
        output: args.output ?? (args as any).o,
        json: args.json ?? false,
      })
    }),
})

export const GithubCommand = cmd({
  command: "github",
  describe: "manage GitHub agent",
  builder: (yargs) => yargs.command(GithubInstallCommand).command(GithubRunCommand).demandCommand(),
  async handler() {},
})
