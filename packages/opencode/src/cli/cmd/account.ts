import path from "node:path"
import { EOL } from "node:os"
import stripAnsi from "strip-ansi"
import { cmd } from "./cmd"
import { Duration, Effect, Match, Option } from "effect"
import { UI } from "../ui"
import { Account } from "@/account/account"
import { AccountID, OrgID, PollExpired, type PollResult, type AccountError } from "@/account/schema"
import { effectCmd } from "../effect-cmd"
import * as Prompt from "../effect/prompt"
import open from "open"

const openBrowser = (url: string) => Effect.promise(() => open(url).catch(() => undefined))

const println = (msg: string) => Effect.sync(() => UI.println(msg))

const dim = (value: string) => UI.Style.TEXT_DIM + value + UI.Style.TEXT_NORMAL

const activeSuffix = (isActive: boolean) => (isActive ? dim(" (active)") : "")

export const defaultConsoleUrl = "https://opencode.ai/console"

export const formatAccountLabel = (account: { email: string; url: string }, isActive: boolean) =>
  `${account.email} ${dim(account.url)}${activeSuffix(isActive)}`

const formatOrgChoiceLabel = (account: { email: string }, org: { name: string }, isActive: boolean) =>
  `${org.name} (${account.email})${activeSuffix(isActive)}`

export const formatOrgLine = (
  account: { email: string; url: string },
  org: { id: string; name: string },
  isActive: boolean,
) => {
  const dot = isActive ? UI.Style.TEXT_SUCCESS + "●" + UI.Style.TEXT_NORMAL : " "
  const name = isActive ? UI.Style.TEXT_HIGHLIGHT_BOLD + org.name + UI.Style.TEXT_NORMAL : org.name
  return `  ${dot} ${name}  ${dim(account.email)}  ${dim(account.url)}  ${dim(org.id)}`
}

const isActiveOrgChoice = (
  active: Option.Option<{ id: AccountID; active_org_id: OrgID | null }>,
  choice: { accountID: AccountID; orgID: OrgID },
) => Option.isSome(active) && active.value.id === choice.accountID && active.value.active_org_id === choice.orgID

const loginEffect = Effect.fn("login")(function* (url: string) {
  const service = yield* Account.Service

  yield* Prompt.intro("Log in")
  const login = yield* service.login(url)

  yield* Prompt.log.info("Go to: " + login.url)
  yield* Prompt.log.info("Enter code: " + login.user)
  yield* openBrowser(login.url)

  const s = Prompt.spinner()
  yield* s.start("Waiting for authorization...")

  const poll = (wait: Duration.Duration): Effect.Effect<PollResult, AccountError> =>
    Effect.gen(function* () {
      yield* Effect.sleep(wait)
      const result = yield* service.poll(login)
      if (result._tag === "PollPending") return yield* poll(wait)
      if (result._tag === "PollSlow") return yield* poll(Duration.sum(wait, Duration.seconds(5)))
      return result
    })

  const result = yield* poll(login.interval).pipe(
    Effect.timeout(login.expiry),
    Effect.catchTag("TimeoutError", () => Effect.succeed(new PollExpired())),
  )

  yield* Match.valueTags(result, {
    PollSuccess: (r) =>
      Effect.gen(function* () {
        yield* s.stop("Logged in as " + r.email)
        yield* Prompt.outro("Done")
      }),
    PollExpired: () => s.stop("Device code expired", 1),
    PollDenied: () => s.stop("Authorization denied", 1),
    PollError: (r) => s.stop("Error: " + String(r.cause), 1),
    PollPending: () => s.stop("Unexpected state", 1),
    PollSlow: () => s.stop("Unexpected state", 1),
  })
})

const logoutEffect = Effect.fn("logout")(function* (email?: string) {
  const service = yield* Account.Service
  const accounts = yield* service.list()
  if (accounts.length === 0) return yield* println("Not logged in")

  if (email) {
    const match = accounts.find((a) => a.email === email)
    if (!match) return yield* println("Account not found: " + email)
    yield* service.remove(match.id)
    yield* Prompt.outro("Logged out from " + email)
    return
  }

  const active = yield* service.active()
  const activeID = Option.map(active, (a) => a.id)

  yield* Prompt.intro("Log out")

  const opts = accounts.map((a) => {
    const isActive = Option.isSome(activeID) && activeID.value === a.id
    return {
      value: a,
      label: formatAccountLabel(a, isActive),
    }
  })

  const selected = yield* Prompt.select({ message: "Select account to log out", options: opts })
  if (Option.isNone(selected)) return

  yield* service.remove(selected.value.id)
  yield* Prompt.outro("Logged out from " + selected.value.email)
})

interface OrgChoice {
  orgID: OrgID
  accountID: AccountID
  label: string
}

const switchEffect = Effect.fn("switch")(function* () {
  const service = yield* Account.Service

  const groups = yield* service.orgsByAccount()
  if (groups.length === 0) return yield* println("Not logged in")

  const active = yield* service.active()

  const opts = groups.flatMap((group) =>
    group.orgs.map((org) => {
      const isActive = isActiveOrgChoice(active, { accountID: group.account.id, orgID: org.id })
      return {
        value: { orgID: org.id, accountID: group.account.id, label: org.name },
        label: formatOrgChoiceLabel(group.account, org, isActive),
      }
    }),
  )
  if (opts.length === 0) return yield* println("No orgs found")

  yield* Prompt.intro("Switch org")

  const selected = yield* Prompt.select<OrgChoice>({ message: "Select org", options: opts })
  if (Option.isNone(selected)) return

  const choice = selected.value
  yield* service.use(choice.accountID, Option.some(choice.orgID))
  yield* Prompt.outro("Switched to " + choice.label)
})

function* writeOutputFile(filePath: string, content: string, label: string) {
  const resolved = path.resolve(filePath)
  yield* Effect.promise(async () => {
    const fs = await import("node:fs/promises")
    await fs.mkdir(path.dirname(resolved), { recursive: true })
    await fs.writeFile(resolved, content, "utf-8")
  })
  UI.println(`Wrote ${label} to ${resolved}`)
}

export interface ConsoleOrgItem {
  id: string
  name: string
  active: boolean
}

export interface ConsoleAccountItem {
  id: string
  email: string
  url: string
  active: boolean
  active_org_id: string | null
  orgs: ConsoleOrgItem[]
}

export function buildAccountOrgsData(
  groups: readonly {
    account: { id: string; email: string; url: string; active_org_id?: string | null }
    orgs: readonly { id: string; name: string }[]
  }[],
  active: Option.Option<{ id: AccountID; active_org_id: OrgID | null }>,
): ConsoleAccountItem[] {
  return groups.map((group) => {
    const isAccountActive = Option.isSome(active) && active.value.id === group.account.id
    return {
      id: group.account.id,
      email: group.account.email,
      url: group.account.url,
      active: isAccountActive,
      active_org_id: group.account.active_org_id ?? null,
      orgs: group.orgs.map((org) => ({
        id: org.id,
        name: org.name,
        active: isActiveOrgChoice(active, {
          accountID: group.account.id as AccountID,
          orgID: org.id as OrgID,
        }),
      })),
    }
  })
}

export interface ConsoleStatusData {
  authenticated: boolean
  account: {
    id: string
    email: string
    url: string
  } | null
  org: {
    id: string
    name?: string
  } | null
}

export function buildConsoleStatusData(
  activeAccount: Option.Option<{ id: string; email: string; url: string; active_org_id?: string | null }>,
  activeOrg: Option.Option<{ id: string; name: string }>,
): ConsoleStatusData {
  if (Option.isNone(activeAccount)) {
    return {
      authenticated: false,
      account: null,
      org: null,
    }
  }

  const account = activeAccount.value
  return {
    authenticated: true,
    account: {
      id: account.id,
      email: account.email,
      url: account.url,
    },
    org: Option.isSome(activeOrg)
      ? {
          id: activeOrg.value.id,
          name: activeOrg.value.name,
        }
      : account.active_org_id
        ? {
            id: account.active_org_id,
          }
        : null,
  }
}

export function formatConsoleStatusText(status: ConsoleStatusData): string[] {
  if (!status.authenticated || !status.account) {
    return ["Not logged in"]
  }
  const lines: string[] = []
  lines.push(`Account: ${status.account.email} (${status.account.url}) [${status.account.id}]`)
  if (status.org) {
    const orgLabel = status.org.name ? `${status.org.name} (${status.org.id})` : status.org.id
    lines.push(`Active Org: ${orgLabel}`)
  } else {
    lines.push("Active Org: (none)")
  }
  return lines
}

export const orgsEffect = Effect.fn("orgs")(function* (args?: { output?: string; json?: boolean }) {
  const service = yield* Account.Service

  const groups = yield* service.orgsByAccount()
  const active = yield* service.active()

  const data = buildAccountOrgsData(groups, active)
  const jsonStr = JSON.stringify(data, null, 2) + EOL

  if (args?.output) {
    if (args.json) {
      yield* writeOutputFile(args.output, jsonStr, "console orgs")
      return
    }

    if (groups.length === 0) {
      yield* writeOutputFile(args.output, "No accounts found" + EOL, "console orgs")
      return
    }
    if (!groups.some((group) => group.orgs.length > 0)) {
      yield* writeOutputFile(args.output, "No orgs found" + EOL, "console orgs")
      return
    }

    const lines: string[] = []
    for (const group of groups) {
      for (const org of group.orgs) {
        const isActive = isActiveOrgChoice(active, { accountID: group.account.id, orgID: org.id })
        lines.push(stripAnsi(formatOrgLine(group.account, org, isActive)))
      }
    }
    yield* writeOutputFile(args.output, lines.join(EOL) + EOL, "console orgs")
    return
  }

  if (args?.json) {
    process.stdout.write(jsonStr)
    return
  }

  if (groups.length === 0) return yield* println("No accounts found")
  if (!groups.some((group) => group.orgs.length > 0)) return yield* println("No orgs found")

  for (const group of groups) {
    for (const org of group.orgs) {
      const isActive = isActiveOrgChoice(active, { accountID: group.account.id, orgID: org.id })
      yield* println(formatOrgLine(group.account, org, isActive))
    }
  }
})

export const statusEffect = Effect.fn("status")(function* (args?: { output?: string; json?: boolean }) {
  const service = yield* Account.Service
  const activeAccount = yield* service.active()
  const activeOrgResult = yield* service.activeOrg().pipe(Effect.catch(() => Effect.succeed(Option.none())))
  const org = Option.map(activeOrgResult, (r) => ({ id: r.org.id, name: r.org.name }))
  const data = buildConsoleStatusData(activeAccount, org)

  const jsonStr = JSON.stringify(data, null, 2) + EOL
  const textLines = formatConsoleStatusText(data)
  const textStr = textLines.join(EOL) + EOL

  if (args?.output) {
    yield* writeOutputFile(args.output, args.json ? jsonStr : textStr, "console status")
    return
  }

  if (args?.json) {
    process.stdout.write(jsonStr)
    return
  }

  for (const line of textLines) {
    yield* println(line)
  }
})

export const openEffect = Effect.fn("open")(function* (args?: { print?: boolean; output?: string; json?: boolean }) {
  const service = yield* Account.Service
  const active = yield* service.active()
  if (Option.isNone(active)) {
    if (args?.json) {
      const jsonStr = JSON.stringify({ url: null }, null, 2) + EOL
      if (args.output) {
        yield* writeOutputFile(args.output, jsonStr, "console url")
        return
      }
      process.stdout.write(jsonStr)
      return
    }
    if (args?.output) {
      yield* writeOutputFile(args.output, "No active account" + EOL, "console url")
      return
    }
    return yield* println("No active account")
  }

  const url = active.value.url
  if (args?.output) {
    const content = args.json ? JSON.stringify({ url }, null, 2) + EOL : url + EOL
    yield* writeOutputFile(args.output, content, "console url")
    return
  }
  if (args?.json) {
    process.stdout.write(JSON.stringify({ url }, null, 2) + EOL)
    return
  }
  if (args?.print) {
    process.stdout.write(url + EOL)
    return
  }
  yield* openBrowser(url)
  yield* Prompt.outro("Opened " + url)
})

export const LoginCommand = effectCmd({
  command: "login [url]",
  describe: false,
  instance: false,
  builder: (yargs) =>
    yargs.positional("url", {
      describe: "server URL",
      type: "string",
    }),
  handler: Effect.fn("Cli.account.login")(function* (args) {
    UI.empty()
    yield* Effect.orDie(loginEffect(args.url ?? defaultConsoleUrl))
  }),
})

export const LogoutCommand = effectCmd({
  command: "logout [email]",
  describe: false,
  instance: false,
  builder: (yargs) =>
    yargs.positional("email", {
      describe: "account email to log out from",
      type: "string",
    }),
  handler: Effect.fn("Cli.account.logout")(function* (args) {
    UI.empty()
    yield* Effect.orDie(logoutEffect(args.email))
  }),
})

export const SwitchCommand = effectCmd({
  command: "switch",
  describe: false,
  instance: false,
  handler: Effect.fn("Cli.account.switch")(function* () {
    UI.empty()
    yield* Effect.orDie(switchEffect())
  }),
})

export const OrgsCommand = effectCmd({
  command: "orgs",
  describe: false,
  instance: false,
  builder: (yargs) =>
    yargs
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write orgs output to file path",
      })
      .option("json", {
        type: "boolean",
        describe: "output as JSON",
      }),
  handler: Effect.fn("Cli.account.orgs")(function* (args: { output?: string; json?: boolean }) {
    if (!args.json && !args.output) {
      UI.empty()
    }
    yield* Effect.orDie(orgsEffect(args))
  }),
})

export const StatusCommand = effectCmd({
  command: "status",
  aliases: ["whoami"],
  describe: false,
  instance: false,
  builder: (yargs) =>
    yargs
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write status output to file path",
      })
      .option("json", {
        type: "boolean",
        describe: "output as JSON",
      }),
  handler: Effect.fn("Cli.account.status")(function* (args: { output?: string; json?: boolean }) {
    if (!args.json && !args.output) {
      UI.empty()
    }
    yield* Effect.orDie(statusEffect(args))
  }),
})

export const OpenCommand = effectCmd({
  command: "open",
  describe: false,
  instance: false,
  builder: (yargs) =>
    yargs
      .option("print", {
        alias: "p",
        type: "boolean",
        describe: "print active console URL instead of opening browser",
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write console URL to file path",
      })
      .option("json", {
        type: "boolean",
        describe: "output as JSON",
      }),
  handler: Effect.fn("Cli.account.open")(function* (args: { print?: boolean; output?: string; json?: boolean }) {
    if (!args.print && !args.json && !args.output) {
      UI.empty()
    }
    yield* Effect.orDie(openEffect(args))
  }),
})

export const ConsoleCommand = cmd({
  command: "console",
  aliases: ["account"],
  describe: false,
  builder: (yargs) =>
    yargs
      .command({
        ...LoginCommand,
        describe: "log in to console",
      })
      .command({
        ...LogoutCommand,
        describe: "log out from console",
      })
      .command({
        ...SwitchCommand,
        describe: "switch active org",
      })
      .command({
        ...OrgsCommand,
        describe: "list orgs",
      })
      .command({
        ...StatusCommand,
        describe: "show console account status",
      })
      .command({
        ...OpenCommand,
        describe: "open active console account",
      })
      .demandCommand(),
  async handler() {},
})
