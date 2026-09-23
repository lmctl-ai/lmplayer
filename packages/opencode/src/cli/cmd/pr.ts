import { Effect } from "effect"
import path from "node:path"
import { EOL } from "node:os"
import { UI } from "../ui"
import { effectCmd, fail } from "../effect-cmd"
import { Git } from "@/git"
import { InstanceRef } from "@/effect/instance-ref"
import { Process } from "@/util/process"
import { which } from "@opencode-ai/core/util/which"

function* writeOutputFile(filePath: string, content: string, label: string) {
  const resolved = path.resolve(filePath)
  yield* Effect.promise(async () => {
    const fs = await import("node:fs/promises")
    await fs.mkdir(path.dirname(resolved), { recursive: true })
    await fs.writeFile(resolved, content, "utf-8")
  })
  UI.println(`Wrote ${label} to ${resolved}`)
}

export interface PrCheckoutResult {
  pr: number
  branch: string
  checkedOut: boolean
  isCrossRepository?: boolean
  forkRemote?: string
  session?: string
  sessionUrl?: string
}

export function buildPrCheckoutResult(opts: {
  pr: number
  branch: string
  forkRemote?: string
  session?: string
  sessionUrl?: string
  isCrossRepository?: boolean
}): PrCheckoutResult {
  return {
    pr: opts.pr,
    branch: opts.branch,
    checkedOut: true,
    ...(opts.isCrossRepository !== undefined && { isCrossRepository: opts.isCrossRepository }),
    ...(opts.forkRemote && { forkRemote: opts.forkRemote }),
    ...(opts.session && { session: opts.session }),
    ...(opts.sessionUrl && { sessionUrl: opts.sessionUrl }),
  }
}

export function formatPrCheckoutText(result: PrCheckoutResult): string[] {
  const lines: string[] = []
  lines.push(`Successfully checked out PR #${result.pr} as branch '${result.branch}'`)
  if (result.forkRemote) {
    lines.push(`Fork remote: ${result.forkRemote}`)
  }
  if (result.session) {
    lines.push(`Session imported: ${result.session}`)
    if (result.sessionUrl) {
      lines.push(`Session URL: ${result.sessionUrl}`)
    }
  }
  return lines
}

export function extractSessionUrlFromPrBody(body?: string | null): string | undefined {
  if (!body) return undefined
  const match = body.match(/https:\/\/opncd\.ai\/s\/([a-zA-Z0-9_-]+)/)
  return match ? match[0] : undefined
}

export function extractSessionIdFromImportOutput(text?: string | null): string | undefined {
  if (!text) return undefined
  const match = text.trim().match(/Imported session: ([a-zA-Z0-9_-]+)/)
  return match ? match[1] : undefined
}

export const PrCommand = effectCmd({
  command: "pr <number>",
  describe: "fetch and checkout a GitHub PR branch, then run lmplayer",
  builder: (yargs) =>
    yargs
      .positional("number", {
        type: "number",
        describe: "PR number to checkout",
        demandOption: true,
      })
      .option("branch", {
        alias: "b",
        type: "string",
        describe: "custom local branch name (defaults to pr/<number>)",
      })
      .option("no-run", {
        type: "boolean",
        describe: "checkout PR branch without launching lmplayer",
        default: false,
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write PR checkout details to file path",
      })
      .option("json", {
        type: "boolean",
        describe: "output as JSON",
      }),
  handler: Effect.fn("Cli.pr")(function* (args: {
    number: number
    branch?: string
    b?: string
    run?: boolean
    "no-run"?: boolean
    noRun?: boolean
    output?: string
    o?: string
    json?: boolean
  }) {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* fail("Could not load instance context")
    if (ctx.project.vcs !== "git") {
      return yield* fail("Could not find git repository. Please run this command from a git repository.")
    }

    const git = yield* Git.Service
    const worktree = ctx.worktree

    const prNumber = args.number
    const localBranchName = args.branch || args.b || `pr/${prNumber}`
    const output = args.output ?? args.o
    const isJson = Boolean(args.json)
    if (!isJson && !output) {
      UI.println(`Fetching and checking out PR #${prNumber}...`)
    }

    const checkout = yield* Effect.promise(() =>
      Process.run(["gh", "pr", "checkout", `${prNumber}`, "--branch", localBranchName, "--force"], { nothrow: true }),
    )
    if (checkout.code !== 0) {
      return yield* fail(`Failed to checkout PR #${prNumber}. Make sure you have gh CLI installed and authenticated.`)
    }

    const prInfoResult = yield* Effect.promise(() =>
      Process.text(
        [
          "gh",
          "pr",
          "view",
          `${prNumber}`,
          "--json",
          "headRepository,headRepositoryOwner,isCrossRepository,headRefName,body",
        ],
        { nothrow: true },
      ),
    )

    let sessionId: string | undefined
    let sessionUrl: string | undefined
    let forkRemote: string | undefined
    let isCrossRepository = false

    if (prInfoResult.code === 0 && prInfoResult.text.trim()) {
      const prInfo = JSON.parse(prInfoResult.text)
      isCrossRepository = Boolean(prInfo?.isCrossRepository)

      if (prInfo?.isCrossRepository && prInfo.headRepository && prInfo.headRepositoryOwner) {
        const forkOwner = prInfo.headRepositoryOwner.login
        const forkName = prInfo.headRepository.name
        const remoteName = forkOwner
        forkRemote = remoteName

        const remotes = (yield* git.run(["remote"], { cwd: worktree })).text().trim()
        if (!remotes.split("\n").includes(remoteName)) {
          yield* git.run(["remote", "add", remoteName, `https://github.com/${forkOwner}/${forkName}.git`], {
            cwd: worktree,
          })
          if (!isJson && !output) {
            UI.println(`Added fork remote: ${remoteName}`)
          }
        }

        yield* git.run(["branch", `--set-upstream-to=${remoteName}/${prInfo.headRefName}`, localBranchName], {
          cwd: worktree,
        })
      }

      const bin = which("lmplayer") ? "lmplayer" : which("opencode") ? "opencode" : "lmplayer"

      if (prInfo?.body) {
        sessionUrl = extractSessionUrlFromPrBody(prInfo.body)
        if (sessionUrl) {
          const url = sessionUrl
          if (!isJson && !output) {
            UI.println(`Found session: ${url}`)
            UI.println(`Importing session...`)
          }

          const importResult = yield* Effect.promise(() =>
            Process.text([bin, "import", url], { nothrow: true }),
          )
          if (importResult.code === 0) {
            sessionId = extractSessionIdFromImportOutput(importResult.text)
            if (sessionId && !isJson && !output) {
              UI.println(`Session imported: ${sessionId}`)
            }
          }
        }
      }
    }

    const result = buildPrCheckoutResult({
      pr: prNumber,
      branch: localBranchName,
      forkRemote,
      session: sessionId,
      sessionUrl,
      isCrossRepository,
    })

    const jsonStr = JSON.stringify(result, null, 2) + EOL
    const textLines = formatPrCheckoutText(result)
    const textStr = textLines.join(EOL) + EOL

    if (output) {
      yield* writeOutputFile(output, isJson ? jsonStr : textStr, "PR checkout")
    }

    if (isJson) {
      process.stdout.write(jsonStr)
      return
    }

    if (!output) {
      UI.println(`Successfully checked out PR #${prNumber} as branch '${localBranchName}'`)
    }

    const skipRun = args.run === false || Boolean(args["no-run"]) || Boolean(args.noRun)
    if (skipRun) {
      return
    }

    UI.println()
    UI.println("Starting lmplayer...")
    UI.println()

    const opencodeArgs = sessionId ? ["-s", sessionId] : []
    const bin = which("lmplayer") ? "lmplayer" : which("opencode") ? "opencode" : "lmplayer"
    const code = yield* Effect.promise(
      () =>
        Process.spawn([bin, ...opencodeArgs], {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
          cwd: process.cwd(),
        }).exited,
    )
    if (code !== 0) return yield* Effect.die(new Error(`${bin} exited with code ${code}`))
  }),
})
