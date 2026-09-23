import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import fs from "node:fs/promises"
import yargs, { type Argv } from "yargs"
import {
  OrchestratorCommand,
  StatusCommand,
  HandoverCommand,
  RefreshCommand,
  AssignCommand,
} from "../../src/cli/cmd/orchestrator"
import { cliIt } from "../lib/cli-process"

describe("OrchestratorCommand subcommands and option parsing", () => {
  test("StatusCommand registers registry, r, output, o, and json options", () => {
    const builder = StatusCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.registry).toBeDefined()
    expect(options.key.r).toBeDefined()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
  })

  test("StatusCommand parses options from arguments", async () => {
    const parsed = await yargs().command({ ...StatusCommand, handler: () => {} }).parseAsync([
      "status",
      "-r",
      "custom-containers.json",
      "-o",
      "status.json",
      "--json",
    ])
    expect(parsed.r).toBe("custom-containers.json")
    expect(parsed.output).toBe("status.json")
    expect(parsed.json).toBe(true)
  })

  test("HandoverCommand registers session, from, to, tail, registry, output, and json options and aliases", () => {
    const builder = HandoverCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.session).toBeDefined()
    expect(options.key.s).toBeDefined()
    expect(options.key.from).toBeDefined()
    expect(options.key.f).toBeDefined()
    expect(options.key.to).toBeDefined()
    expect(options.key.t).toBeDefined()
    expect(options.key.tail).toBeDefined()
    expect(options.key.n).toBeDefined()
    expect(options.key.registry).toBeDefined()
    expect(options.key.r).toBeDefined()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
  })

  test("HandoverCommand parses options and aliases from arguments", async () => {
    const parsed = await yargs().command({ ...HandoverCommand, handler: () => {} }).parseAsync([
      "handover",
      "-s",
      "session-42",
      "-f",
      "container-a",
      "-t",
      "container-b",
      "-n",
      "50",
      "-r",
      "containers.json",
      "-o",
      "handover.json",
      "--json",
    ])
    expect(parsed.s).toBe("session-42")
    expect(parsed.f).toBe("container-a")
    expect(parsed.t).toBe("container-b")
    expect(parsed.n).toBe(50)
    expect(parsed.r).toBe("containers.json")
    expect(parsed.output).toBe("handover.json")
    expect(parsed.json).toBe(true)
  })

  test("RefreshCommand registers to, registry, output, and json options and aliases", () => {
    const builder = RefreshCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.to).toBeDefined()
    expect(options.key.t).toBeDefined()
    expect(options.key.registry).toBeDefined()
    expect(options.key.r).toBeDefined()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
  })

  test("RefreshCommand parses options and aliases from arguments", async () => {
    const parsed = await yargs().command({ ...RefreshCommand, handler: () => {} }).parseAsync([
      "refresh",
      "-t",
      "container-1",
      "-r",
      "containers.json",
      "-o",
      "refresh.json",
      "--json",
    ])
    expect(parsed.t).toBe("container-1")
    expect(parsed.r).toBe("containers.json")
    expect(parsed.output).toBe("refresh.json")
    expect(parsed.json).toBe(true)
  })

  test("AssignCommand registers session, to, registry, output, and json options and aliases", () => {
    const builder = AssignCommand.builder as (y: Argv) => Argv<any>
    const parser = builder(yargs())
    const options = (parser as any).getOptions()
    expect(options.key.session).toBeDefined()
    expect(options.key.s).toBeDefined()
    expect(options.key.to).toBeDefined()
    expect(options.key.t).toBeDefined()
    expect(options.key.registry).toBeDefined()
    expect(options.key.r).toBeDefined()
    expect(options.key.output).toBeDefined()
    expect(options.key.o).toBeDefined()
    expect(options.key.json).toBeDefined()
  })

  test("AssignCommand parses options and aliases from arguments", async () => {
    const parsed = await yargs().command({ ...AssignCommand, handler: () => {} }).parseAsync([
      "assign",
      "-s",
      "session-100",
      "-t",
      "container-2",
      "-r",
      "containers.json",
      "-o",
      "assign.json",
      "--json",
    ])
    expect(parsed.s).toBe("session-100")
    expect(parsed.t).toBe("container-2")
    expect(parsed.r).toBe("containers.json")
    expect(parsed.output).toBe("assign.json")
    expect(parsed.json).toBe(true)
  })
})

describe("opencode orchestrator commands (non-interactive subprocess)", () => {
  cliIt.concurrent(
    "orchestrator status supports -o text and json export",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        // Text file output
        const textOut = path.join(home, "orchestrator-status.txt")
        const resText = yield* opencode.spawn(["orchestrator", "status", "-o", textOut])
        opencode.expectExit(resText, 0)
        expect(resText.stderr).toContain("Wrote orchestrator status to")
        const textContent = yield* Effect.promise(() => fs.readFile(textOut, "utf-8"))
        expect(textContent).toContain("Containers")
        expect(textContent).toContain("Assignments")

        // JSON file output
        const jsonOut = path.join(home, "orchestrator-status.json")
        const resJson = yield* opencode.spawn(["orchestrator", "status", "--output", jsonOut, "--json"])
        opencode.expectExit(resJson, 0)
        expect(resJson.stderr).toContain("Wrote orchestrator status to")
        const jsonContent = yield* Effect.promise(() => fs.readFile(jsonOut, "utf-8"))
        const parsed = JSON.parse(jsonContent)
        expect(parsed).toHaveProperty("containers")
        expect(parsed).toHaveProperty("assignments")
      }),
    60_000,
  )

  cliIt.concurrent(
    "orchestrator assign supports -o file export and updates assignment map",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const assignOut = path.join(home, "assign.json")
        const resAssign = yield* opencode.spawn([
          "orchestrator",
          "assign",
          "--session",
          "sess-test-1",
          "--to",
          "http://localhost:9000",
          "-o",
          assignOut,
          "--json",
        ])
        opencode.expectExit(resAssign, 0)
        expect(resAssign.stderr).toContain("Wrote assignment to")
        const jsonContent = yield* Effect.promise(() => fs.readFile(assignOut, "utf-8"))
        const parsed = JSON.parse(jsonContent)
        expect(parsed.session).toBe("sess-test-1")
        expect(parsed.containerID).toBe("http://localhost:9000")
        expect(parsed.epoch).toBe(1)

        // Verify status reflects the assignment
        const statusRes = yield* opencode.spawn(["orchestrator", "status", "--json"])
        opencode.expectExit(statusRes, 0)
        const statusParsed = JSON.parse(statusRes.stdout)
        expect(statusParsed.assignments).toHaveProperty("sess-test-1")
        expect(statusParsed.assignments["sess-test-1"].containerID).toBe("http://localhost:9000")
      }),
    60_000,
  )
})
