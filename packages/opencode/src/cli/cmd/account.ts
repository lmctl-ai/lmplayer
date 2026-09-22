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

function* writeOutputFile(filePath: string, content: string, label: string) {
  const resolved = path.resolve(filePath)
  yield* Effect.promise(async () => {
    const fs = await import("node:fs/promises")
    await fs.mkdir(path.dirname(resolved), { recursive: true })
    await fs.writeFile(resolved, content, "utf-8")
  })
  UI.println(`Wrote ${label} to ${resolved}`)
}

export const loginEffect = Effect.fn("login")(function* (
  url: string,
  args?: { output?: string; json?: boolean },
) {
  const service = yield* Account.Service

  const writeLoginResult = (payload: { ok: boolean; email?: string; url?: string; error?: string }) =>
    Effect.gen(function* () {
      if (args?.json) {
        const jsonStr = JSON.stringify(payload, null, 2) + EOL
        if (args.output) {
          yield* writeOutputFile(args.output, jsonStr, "console login")
        }
        process.stdout.write(jsonStr)
        if (!payload.ok) process.exitCode = 1
        return
      }
      if (args?.output) {
        const text = payload.ok
          ? `Logged in as ${payload.email} (${payload.url})${EOL}`
          : `Login failed: ${payload.error ?? "error"}${EOL}`
        yield* writeOutputFile(args.output, text, "console login")
      }
      if (!payload.ok) {
        process.exitCode = 1
      }
    })

  if (!args?.json) {
    yield* Prompt.intro("Log in")
  }
  const login = yield* service.login(url)

  if (args?.json) {
    process.stderr.write(`Go to: ${login.url}${EOL}`)
    process.stderr.write(`Enter code: ${login.user}${EOL}`)
  } else {
    yield* Prompt.log.info("Go to: " + login.url)
    yield* Prompt.log.info("Enter code: " + login.user)
  }
  yield* openBrowser(login.url)

  const s = Prompt.spinner()
  if (!args?.json) {
    yield* s.start("Waiting for authorization...")
  }

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
        if (!args?.json) {
          yield* s.stop("Logged in as " + r.email)
          yield* Prompt.outro("Done")
        }
        yield* writeLoginResult({ ok: true, email: r.email, url })
      }),
    PollExpired: () =>
      Effect.gen(function* () {
        if (!args?.json) yield* s.stop("Device code expired", 1)
        yield* writeLoginResult({ ok: false, error: "Device code expired", url })
      }),
    PollDenied: () =>
      Effect.gen(function* () {
        if (!args?.json) yield* s.stop("Authorization denied", 1)
        yield* writeLoginResult({ ok: false, error: "Authorization denied", url })
      }),
    PollError: (r) =>
      Effect.gen(function* () {
        if (!args?.json) yield* s.stop("Error: " + String(r.cause), 1)
        yield* writeLoginResult({ ok: false, error: String(r.cause), url })
      }),
    PollPending: () =>
      Effect.gen(function* () {
        if (!args?.json) yield* s.stop("Unexpected state", 1)
        yield* writeLoginResult({ ok: false, error: "Unexpected state", url })
      }),
    PollSlow: () =>
      Effect.gen(function* () {
        if (!args?.json) yield* s.stop("Unexpected state", 1)
        yield* writeLoginResult({ ok: false, error: "Unexpected state", url })
      }),
  })
})

export const logoutEffect = Effect.fn("logout")(function* (args?: {
  email?: string
  force?: boolean
  json?: boolean
  output?: string
}) {
  const service = yield* Account.Service
  const accounts = yield* service.list()

  const writeLogoutResult = (payload: {
    ok: boolean
    email?: string
    id?: string
    removed: boolean
    message?: string
    error?: string
  }) =>
    Effect.gen(function* () {
      if (args?.json) {
        const jsonStr = JSON.stringify(payload, null, 2) + EOL
        if (args.output) {
          yield* writeOutputFile(args.output, jsonStr, "console logout")
        }
        process.stdout.write(jsonStr)
        if (!payload.ok && !args.force) process.exitCode = 1
        return
      }
      if (args?.output) {
        const text = payload.ok
          ? `Logged out from ${payload.email ?? "account"}${payload.message ? ` (${payload.message})` : ""}${EOL}`
          : `Logout failed: ${payload.error ?? payload.message ?? "error"}${EOL}`
        yield* writeOutputFile(args.output, text, "console logout")
      }
      if (!payload.ok) {
        if (!args?.force) process.exitCode = 1
        yield* println(payload.error ?? payload.message ?? "Error")
        return
      }
      if (!args?.output) {
        yield* Prompt.outro(payload.message ?? `Logged out from ${payload.email}`)
      }
    })

  if (accounts.length === 0) {
    if (args?.force) {
      return yield* writeLogoutResult({
        ok: true,
        email: args.email,
        removed: false,
        message: "Not logged in",
      })
    }
    if (args?.json || args?.output) {
      return yield* writeLogoutResult({
        ok: false,
        email: args.email,
        removed: false,
        error: "Not logged in",
      })
    }
    return yield* println("Not logged in")
  }

  if (args?.email) {
    const match = accounts.find((a) => a.email === args.email || a.id === args.email)
    if (!match) {
      if (args.force) {
        return yield* writeLogoutResult({
          ok: true,
          email: args.email,
          removed: false,
          message: `Account not found: ${args.email}`,
        })
      }
      if (args.json || args.output) {
        return yield* writeLogoutResult({
          ok: false,
          email: args.email,
          removed: false,
          error: `Account not found: ${args.email}`,
        })
      }
      return yield* println("Account not found: " + args.email)
    }
    yield* service.remove(match.id)
    return yield* writeLogoutResult({
      ok: true,
      email: match.email,
      id: match.id,
      removed: true,
      message: `Logged out from ${match.email}`,
    })
  }

  const active = yield* service.active()
  if (args?.json || !process.stdin.isTTY) {
    if (Option.isSome(active)) {
      yield* service.remove(active.value.id)
      return yield* writeLogoutResult({
        ok: true,
        email: active.value.email,
        id: active.value.id,
        removed: true,
        message: `Logged out from active account ${active.value.email}`,
      })
    }
    if (args?.force) {
      return yield* writeLogoutResult({
        ok: true,
        removed: false,
        message: "No active account to log out from",
      })
    }
    return yield* writeLogoutResult({
      ok: false,
      removed: false,
      error: "Account email is required in non-interactive mode",
    })
  }

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
  return yield* writeLogoutResult({
    ok: true,
    email: selected.value.email,
    id: selected.value.id,
    removed: true,
    message: `Logged out from ${selected.value.email}`,
  })
})

interface OrgChoice {
  orgID: OrgID
  accountID: AccountID
  label: string
}

export const switchEffect = Effect.fn("switch")(function* (args?: {
  org?: string
  output?: string
  json?: boolean
}) {
  const service = yield* Account.Service

  const groups = yield* service.orgsByAccount()
  const writeSwitchResult = (payload: {
    ok: boolean
    org?: { id: string; name: string }
    account?: { id: string; email: string }
    error?: string
  }) =>
    Effect.gen(function* () {
      if (args?.json) {
        const jsonStr = JSON.stringify(payload, null, 2) + EOL
        if (args.output) {
          yield* writeOutputFile(args.output, jsonStr, "console switch")
        }
        process.stdout.write(jsonStr)
        if (!payload.ok) process.exitCode = 1
        return
      }
      if (args?.output) {
        const text = payload.ok
          ? `Switched to ${payload.org?.name ?? payload.org?.id ?? "org"} (${payload.account?.email ?? ""})${EOL}`
          : `Switch failed: ${payload.error ?? "error"}${EOL}`
        yield* writeOutputFile(args.output, text, "console switch")
      }
      if (!payload.ok) {
        process.exitCode = 1
        yield* println(payload.error ?? "Error")
        return
      }
      if (!args?.output) {
        yield* Prompt.outro("Switched to " + (payload.org?.name ?? payload.org?.id))
      }
    })

  if (groups.length === 0) {
    if (args?.json || args?.output) {
      return yield* writeSwitchResult({ ok: false, error: "Not logged in" })
    }
    return yield* println("Not logged in")
  }

  const active = yield* service.active()

  const allChoices: OrgChoice[] = groups.flatMap((group) =>
    group.orgs.map((org) => {
      return {
        orgID: org.id as OrgID,
        accountID: group.account.id as AccountID,
        label: org.name,
      }
    }),
  )
  if (allChoices.length === 0) {
    if (args?.json || args?.output) {
      return yield* writeSwitchResult({ ok: false, error: "No orgs found" })
    }
    return yield* println("No orgs found")
  }

  if (args?.org) {
    const match = allChoices.find(
      (c) => c.orgID === args.org || c.label.toLowerCase() === args.org!.toLowerCase(),
    )
    if (!match) {
      if (args.json || args.output) {
        return yield* writeSwitchResult({ ok: false, error: `Organization not found: ${args.org}` })
      }
      return yield* println(`Organization not found: ${args.org}`)
    }
    yield* service.use(match.accountID, Option.some(match.orgID))
    const group = groups.find((g) => g.account.id === match.accountID)
    return yield* writeSwitchResult({
      ok: true,
      org: { id: match.orgID, name: match.label },
      account: group ? { id: group.account.id, email: group.account.email } : undefined,
    })
  }

  if (args?.json || !process.stdin.isTTY) {
    return yield* writeSwitchResult({
      ok: false,
      error: "Organization ID or name is required in non-interactive mode",
    })
  }

  // Interactive selection
  const opts = groups.flatMap((group) =>
    group.orgs.map((org) => {
      const isActive = isActiveOrgChoice(active, { accountID: group.account.id, orgID: org.id })
      return {
        value: { orgID: org.id, accountID: group.account.id, label: org.name },
        label: formatOrgChoiceLabel(group.account, org, isActive),
      }
    }),
  )

  yield* Prompt.intro("Switch org")
  const selected = yield* Prompt.select<OrgChoice>({ message: "Select org", options: opts })
  if (Option.isNone(selected)) return

  const choice = selected.value
  yield* service.use(choice.accountID, Option.some(choice.orgID))
  const group = groups.find((g) => g.account.id === choice.accountID)
  return yield* writeSwitchResult({
    ok: true,
    org: { id: choice.orgID, name: choice.label },
    account: group ? { id: group.account.id, email: group.account.email } : undefined,
  })
})

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
    yargs
      .positional("url", {
        describe: "server URL",
        type: "string",
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write login result to output file path",
      })
      .option("json", {
        type: "boolean",
        describe: "output as JSON",
      }),
  handler: Effect.fn("Cli.account.login")(function* (args: {
    url?: string
    output?: string
    json?: boolean
  }) {
    if (!args.json && !args.output) {
      UI.empty()
    }
    yield* Effect.orDie(loginEffect(args.url ?? defaultConsoleUrl, args))
  }),
})

export const LogoutCommand = effectCmd({
  command: "logout [email]",
  describe: false,
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("email", {
        describe: "account email to log out from",
        type: "string",
      })
      .option("force", {
        alias: "f",
        describe: "do not exit non-zero if account is not found",
        type: "boolean",
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write logout result to output file path",
      })
      .option("json", {
        type: "boolean",
        describe: "output JSON result",
      }),
  handler: Effect.fn("Cli.account.logout")(function* (args: {
    email?: string
    force?: boolean
    output?: string
    json?: boolean
  }) {
    if (!args.json && !args.output) {
      UI.empty()
    }
    yield* Effect.orDie(logoutEffect(args))
  }),
})

export const SwitchCommand = effectCmd({
  command: "switch [org]",
  describe: false,
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("org", {
        describe: "organization ID or name to switch to",
        type: "string",
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "write switch result to output file path",
      })
      .option("json", {
        type: "boolean",
        describe: "output as JSON",
      }),
  handler: Effect.fn("Cli.account.switch")(function* (args: {
    org?: string
    output?: string
    json?: boolean
  }) {
    if (!args.json && !args.output) {
      UI.empty()
    }
    yield* Effect.orDie(switchEffect(args))
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
