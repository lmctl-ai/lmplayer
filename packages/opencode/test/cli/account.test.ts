import { describe, expect, test } from "bun:test"
import stripAnsi from "strip-ansi"
import { Option } from "effect"
import path from "node:path"
import fs from "node:fs/promises"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"
import { AccountID, OrgID } from "../../src/account/schema"
import {
  defaultConsoleUrl,
  formatAccountLabel,
  formatOrgLine,
  buildAccountOrgsData,
  buildConsoleStatusData,
  formatConsoleStatusText,
} from "../../src/cli/cmd/account"

describe("console account display and data builders", () => {
  test("uses opencode.ai/console as the default login URL", () => {
    expect(defaultConsoleUrl).toBe("https://opencode.ai/console")
  })

  test("includes the account url in account labels", () => {
    expect(stripAnsi(formatAccountLabel({ email: "one@example.com", url: "https://one.example.com" }, false))).toBe(
      "one@example.com https://one.example.com",
    )
  })

  test("includes the active marker in account labels", () => {
    expect(stripAnsi(formatAccountLabel({ email: "one@example.com", url: "https://one.example.com" }, true))).toBe(
      "one@example.com https://one.example.com (active)",
    )
  })

  test("includes the account url in org rows", () => {
    expect(
      stripAnsi(
        formatOrgLine({ email: "one@example.com", url: "https://one.example.com" }, { id: "org-1", name: "One" }, true),
      ),
    ).toBe("  ● One  one@example.com  https://one.example.com  org-1")
  })

  test("buildAccountOrgsData returns empty array when no accounts exist", () => {
    const data = buildAccountOrgsData([], Option.none())
    expect(data).toEqual([])
  })

  test("buildAccountOrgsData correctly marks active account and active org", () => {
    const groups = [
      {
        account: {
          id: "acc-1",
          email: "one@example.com",
          url: "https://one.example.com",
          active_org_id: "org-1",
        },
        orgs: [
          { id: "org-1", name: "Org One" },
          { id: "org-2", name: "Org Two" },
        ],
      },
      {
        account: {
          id: "acc-2",
          email: "two@example.com",
          url: "https://two.example.com",
          active_org_id: null,
        },
        orgs: [{ id: "org-3", name: "Org Three" }],
      },
    ]

    const active = Option.some({
      id: AccountID.make("acc-1"),
      active_org_id: OrgID.make("org-1"),
    })

    const data = buildAccountOrgsData(groups, active)
    expect(data).toHaveLength(2)

    expect(data[0].id).toBe("acc-1")
    expect(data[0].email).toBe("one@example.com")
    expect(data[0].url).toBe("https://one.example.com")
    expect(data[0].active).toBe(true)
    expect(data[0].active_org_id).toBe("org-1")
    expect(data[0].orgs).toEqual([
      { id: "org-1", name: "Org One", active: true },
      { id: "org-2", name: "Org Two", active: false },
    ])

    expect(data[1].id).toBe("acc-2")
    expect(data[1].active).toBe(false)
    expect(data[1].active_org_id).toBeNull()
    expect(data[1].orgs).toEqual([
      { id: "org-3", name: "Org Three", active: false },
    ])
  })

  test("buildConsoleStatusData and formatConsoleStatusText when unauthenticated", () => {
    const status = buildConsoleStatusData(Option.none(), Option.none())
    expect(status).toEqual({
      authenticated: false,
      account: null,
      org: null,
    })
    expect(formatConsoleStatusText(status)).toEqual(["Not logged in"])
  })

  test("buildConsoleStatusData and formatConsoleStatusText when authenticated with active org", () => {
    const account = Option.some({
      id: "acc-1",
      email: "one@example.com",
      url: "https://one.example.com",
      active_org_id: "org-1",
    })
    const org = Option.some({ id: "org-1", name: "Engineering" })

    const status = buildConsoleStatusData(account, org)
    expect(status).toEqual({
      authenticated: true,
      account: {
        id: "acc-1",
        email: "one@example.com",
        url: "https://one.example.com",
      },
      org: {
        id: "org-1",
        name: "Engineering",
      },
    })
    expect(formatConsoleStatusText(status)).toEqual([
      "Account: one@example.com (https://one.example.com) [acc-1]",
      "Active Org: Engineering (org-1)",
    ])
  })

  test("buildConsoleStatusData and formatConsoleStatusText when authenticated without active org", () => {
    const account = Option.some({
      id: "acc-2",
      email: "two@example.com",
      url: "https://two.example.com",
      active_org_id: null,
    })

    const status = buildConsoleStatusData(account, Option.none())
    expect(status.authenticated).toBe(true)
    expect(status.org).toBeNull()
    expect(formatConsoleStatusText(status)).toEqual([
      "Account: two@example.com (https://two.example.com) [acc-2]",
      "Active Org: (none)",
    ])
  })
})

describe("console commands CLI export and json flags", () => {
  cliIt.concurrent(
    "console orgs supports -o text and json export when not logged in",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        // Direct JSON stdout
        const stdoutRes = yield* opencode.spawn(["console", "orgs", "--json"])
        opencode.expectExit(stdoutRes, 0)
        expect(JSON.parse(stdoutRes.stdout.trim())).toEqual([])

        // File JSON output
        const jsonOut = path.join(home, "orgs.json")
        const resJson = yield* opencode.spawn(["console", "orgs", "-o", jsonOut, "--json"])
        opencode.expectExit(resJson, 0)
        expect(resJson.stderr).toContain("Wrote console orgs to")
        const jsonContent = yield* Effect.promise(() => fs.readFile(jsonOut, "utf-8"))
        expect(JSON.parse(jsonContent.trim())).toEqual([])

        // File text output
        const textOut = path.join(home, "orgs.txt")
        const resText = yield* opencode.spawn(["console", "orgs", "-o", textOut])
        opencode.expectExit(resText, 0)
        expect(resText.stderr).toContain("Wrote console orgs to")
        const textContent = yield* Effect.promise(() => fs.readFile(textOut, "utf-8"))
        expect(textContent.trim()).toBe("No accounts found")
      }),
    60_000,
  )

  cliIt.concurrent(
    "console status and account whoami support -o file export and json",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        // Direct JSON stdout
        const resStatus = yield* opencode.spawn(["console", "status", "--json"])
        opencode.expectExit(resStatus, 0)
        const statusParsed = JSON.parse(resStatus.stdout.trim())
        expect(statusParsed).toEqual({
          authenticated: false,
          account: null,
          org: null,
        })

        // File JSON output
        const jsonOut = path.join(home, "status.json")
        const resJson = yield* opencode.spawn(["account", "whoami", "-o", jsonOut, "--json"])
        opencode.expectExit(resJson, 0)
        expect(resJson.stderr).toContain("Wrote console status to")
        const jsonContent = yield* Effect.promise(() => fs.readFile(jsonOut, "utf-8"))
        expect(JSON.parse(jsonContent.trim())).toEqual({
          authenticated: false,
          account: null,
          org: null,
        })

        // File text output
        const textOut = path.join(home, "status.txt")
        const resText = yield* opencode.spawn(["console", "status", "-o", textOut])
        opencode.expectExit(resText, 0)
        expect(resText.stderr).toContain("Wrote console status to")
        const textContent = yield* Effect.promise(() => fs.readFile(textOut, "utf-8"))
        expect(textContent.trim()).toBe("Not logged in")
      }),
    60_000,
  )

  cliIt.concurrent(
    "console open supports --print and file export",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        // Direct print when not logged in
        const resPrint = yield* opencode.spawn(["console", "open", "--print"])
        opencode.expectExit(resPrint, 0)
        expect(resPrint.stderr).toContain("No active account")

        // JSON file output
        const jsonOut = path.join(home, "console-url.json")
        const resJson = yield* opencode.spawn(["console", "open", "-o", jsonOut, "--json"])
        opencode.expectExit(resJson, 0)
        expect(resJson.stderr).toContain("Wrote console url to")
        const jsonContent = yield* Effect.promise(() => fs.readFile(jsonOut, "utf-8"))
        expect(JSON.parse(jsonContent.trim())).toEqual({ url: null })
      }),
    60_000,
  )
})
