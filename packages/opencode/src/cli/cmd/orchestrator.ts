import type { Argv } from "yargs"
import { EOL } from "os"
import path from "path"
import { mkdir, rename } from "fs/promises"
import { Global } from "@opencode-ai/core/global"
import { ServerAuth } from "@/server/auth"
import { cmd } from "./cmd"
import { UI } from "../ui"

// All human-readable output goes to stdout (UI.println targets stderr, which
// would interleave with these structured listings); --json also prints to stdout.
function out(line: string) {
  process.stdout.write(line + EOL)
}

// ---------------------------------------------------------------------------
// Lightweight orchestrator for lmcode agent containers (ORGANIZE design Phase R,
// slice R1). This is a SEPARATE coordination role: it talks to containers purely
// over HTTP (driving the H1 export + H2 import endpoints) and never loads the
// full server. It tracks a durable assignment map with a monotonic per-session
// epoch so a future R2 can enforce a container-side ownership fence.
//
// R1 SCOPE: manual handover driver + status/health + assignment map. There is NO
// auto-failover and NO container-side run/write-back epoch enforcement yet — see
// the printed manual-safe warning on `handover`.
// ---------------------------------------------------------------------------

type Container = { id: string; url: string; username?: string; password?: string }
type Registry = { containers: Container[] }

type Assignment = { containerID: string; url: string; epoch: number; updatedAt: number }
type AssignmentMap = Record<string, Assignment>

function defaultRegistryPath() {
  return path.join(Global.Path.config, "containers.json")
}

function assignmentsPath() {
  return path.join(Global.Path.data, "orchestrator", "assignments.json")
}

async function loadRegistry(file: string): Promise<Registry> {
  const f = Bun.file(file)
  if (!(await f.exists())) throw new Error(`registry not found: ${file}`)
  const json = (await f.json()) as Registry
  if (!json || !Array.isArray(json.containers)) throw new Error(`invalid registry (expected { containers: [...] }): ${file}`)
  return json
}

async function loadAssignments(): Promise<AssignmentMap> {
  const f = Bun.file(assignmentsPath())
  if (!(await f.exists())) return {}
  return (await f.json()) as AssignmentMap
}

async function saveAssignments(map: AssignmentMap): Promise<void> {
  const target = assignmentsPath()
  await mkdir(path.dirname(target), { recursive: true })
  // temp + rename keeps the file from being observed half-written.
  const tmp = `${target}.${process.pid}.tmp`
  await Bun.write(tmp, JSON.stringify(map, null, 2))
  await rename(tmp, target)
}

// Resolve a from/to argument to a container: match a registry id, or accept a
// raw http(s) URL as an anonymous container.
function resolveContainer(registry: Registry, idOrUrl: string): Container {
  const byId = registry.containers.find((c) => c.id === idOrUrl)
  if (byId) return byId
  if (/^https?:\/\//.test(idOrUrl)) return { id: idOrUrl, url: idOrUrl }
  throw new Error(`container not found in registry: ${idOrUrl}`)
}

function authHeaders(container: Container) {
  return ServerAuth.headers({ username: container.username, password: container.password }) ?? {}
}

// Validate the remote responses BEFORE any assignment mutation. The CLI does not
// load the server, so importing the Effect ExportBundle/ImportResult schemas here
// would drag in the whole HttpApi; a tight structural check on the contract
// fields is sufficient and keeps the orchestrator dependency-light. A malformed
// 200 throws (caller exits non-zero) and never advances the epoch.
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

type Bundle = { session: { id: string }; tail: unknown[] }

function validateBundle(json: unknown, sessionID: string, fromID: string): Bundle {
  if (!isObject(json) || !isObject(json.session) || typeof json.session.id !== "string" || !Array.isArray(json.tail)) {
    throw new Error(`export from ${fromID} returned a malformed bundle (expected { session.id, tail[] })`)
  }
  if (json.session.id !== sessionID) {
    throw new Error(`export from ${fromID} returned the wrong session: expected ${sessionID}, got ${json.session.id}`)
  }
  return json as Bundle
}

type ImportResult = { sessionID: string; imported: boolean; existed: boolean; messageCount: number; hadMemory: boolean }

function validateImportResult(json: unknown, sessionID: string, toID: string): ImportResult {
  if (!isObject(json) || json.imported !== true || typeof json.sessionID !== "string" || typeof json.messageCount !== "number") {
    throw new Error(`import to ${toID} returned a malformed result (expected { imported: true, sessionID, messageCount })`)
  }
  if (json.sessionID !== sessionID) {
    throw new Error(`import to ${toID} reported the wrong session: expected ${sessionID}, got ${json.sessionID}`)
  }
  return json as ImportResult
}

type Health = { id: string; url: string; reachable: boolean; status: number | null; latencyMs: number; error?: string }

async function health(container: Container): Promise<Health> {
  const start = Date.now()
  try {
    const res = await fetch(`${container.url.replace(/\/$/, "")}/session`, {
      headers: authHeaders(container),
      signal: AbortSignal.timeout(5000),
    })
    // Any HTTP response (even 401/500) means the container is reachable on the
    // network; only a thrown fetch/timeout error counts as unreachable.
    return { id: container.id, url: container.url, reachable: true, status: res.status, latencyMs: Date.now() - start }
  } catch (e) {
    return {
      id: container.id,
      url: container.url,
      reachable: false,
      status: null,
      latencyMs: Date.now() - start,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------
const StatusCommand = cmd({
  command: "status",
  describe: "health-check registered containers and show the assignment map",
  builder: (yargs: Argv) =>
    yargs
      .option("registry", { describe: "path to containers.json", type: "string" })
      .option("json", { describe: "output as JSON", type: "boolean" }),
  async handler(args) {
    const registry = await loadRegistry(args.registry ?? defaultRegistryPath())
    const assignments = await loadAssignments()
    const healths = await Promise.all(registry.containers.map(health))

    if (args.json) {
      process.stdout.write(JSON.stringify({ containers: healths, assignments }, null, 2) + EOL)
      return
    }

    out(UI.Style.TEXT_HIGHLIGHT_BOLD + "Containers" + UI.Style.TEXT_NORMAL)
    for (const h of healths) {
      const mark = h.reachable ? UI.Style.TEXT_SUCCESS_BOLD + "reachable" : UI.Style.TEXT_DANGER_BOLD + "unreachable"
      out(
        `  ${h.id}  ${h.url}  ${mark}${UI.Style.TEXT_NORMAL}  (${h.status ?? "-"}, ${h.latencyMs}ms)` +
          (h.error ? `  ${h.error}` : ""),
      )
    }

    out("")
    out(UI.Style.TEXT_HIGHLIGHT_BOLD + "Assignments" + UI.Style.TEXT_NORMAL)
    const entries = Object.entries(assignments)
    if (entries.length === 0) out("  (none)")
    for (const [sessionID, a] of entries) {
      out(`  ${sessionID}  ->  ${a.containerID} (${a.url})  epoch=${a.epoch}`)
    }
  },
})

// ---------------------------------------------------------------------------
// handover
// ---------------------------------------------------------------------------
const HandoverCommand = cmd({
  command: "handover",
  describe: "move a session from one container to another via export/import",
  builder: (yargs: Argv) =>
    yargs
      .option("session", { describe: "session id to hand over", type: "string", demandOption: true })
      .option("from", { describe: "source container id (or url)", type: "string", demandOption: true })
      .option("to", { describe: "destination container id (or url)", type: "string", demandOption: true })
      .option("tail", { describe: "number of tail messages to carry", type: "number", default: 20 })
      .option("registry", { describe: "path to containers.json", type: "string" })
      .option("json", { describe: "output as JSON", type: "boolean" }),
  async handler(args) {
    const registry = await loadRegistry(args.registry ?? defaultRegistryPath())
    const from = resolveContainer(registry, args.from)
    const to = resolveContainer(registry, args.to)

    // MANUAL-SAFE CONSTRAINT (R1): until R2 adds a container-side epoch fence
    // (a revived/stale-epoch container must refuse to run/write its bundle), the
    // operator MUST ensure the source session is not actively running anywhere
    // before handing it over. We record the new epoch now so R2 can enforce it.
    if (!args.json) {
      out(
        UI.Style.TEXT_WARNING_BOLD +
          "WARNING: manual-safe handover. Ensure the source session is NOT running before continuing (no epoch fence yet)." +
          UI.Style.TEXT_NORMAL,
      )
    }

    const exportURL = `${from.url.replace(/\/$/, "")}/session/${args.session}/export?tail=${args.tail}`
    const exportRes = await fetch(exportURL, { headers: authHeaders(from), signal: AbortSignal.timeout(30000) })
    if (!exportRes.ok) throw new Error(`export from ${from.id} failed: HTTP ${exportRes.status} ${await exportRes.text()}`)
    const bundle = validateBundle(await exportRes.json(), args.session, from.id)

    const importRes = await fetch(`${to.url.replace(/\/$/, "")}/session/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(to) },
      body: JSON.stringify(bundle),
      signal: AbortSignal.timeout(30000),
    })
    if (!importRes.ok) throw new Error(`import to ${to.id} failed: HTTP ${importRes.status} ${await importRes.text()}`)
    const result = validateImportResult(await importRes.json(), args.session, to.id)

    // Only AFTER both responses validate do we touch the durable assignment map /
    // bump the epoch. A malformed 200 must never advance the epoch.
    const assignments = await loadAssignments()
    const epoch = (assignments[args.session]?.epoch ?? 0) + 1
    assignments[args.session] = { containerID: to.id, url: to.url, epoch, updatedAt: Date.now() }
    await saveAssignments(assignments)

    if (args.json) {
      process.stdout.write(JSON.stringify({ from: from.id, to: to.id, epoch, ...result }, null, 2) + EOL)
      return
    }
    out(
      UI.Style.TEXT_SUCCESS_BOLD +
        `handover ${from.id} -> ${to.id}` +
        UI.Style.TEXT_NORMAL +
        `  session=${result.sessionID} messages=${result.messageCount} memory=${result.hadMemory} existed=${result.existed} epoch=${epoch}`,
    )
  },
})

// ---------------------------------------------------------------------------
// assign
// ---------------------------------------------------------------------------
const AssignCommand = cmd({
  command: "assign",
  describe: "record (or replace) a session's home container without moving data",
  builder: (yargs: Argv) =>
    yargs
      .option("session", { describe: "session id", type: "string", demandOption: true })
      .option("to", { describe: "destination container id (or url)", type: "string", demandOption: true })
      .option("registry", { describe: "path to containers.json", type: "string" })
      .option("json", { describe: "output as JSON", type: "boolean" }),
  async handler(args) {
    const registry = await loadRegistry(args.registry ?? defaultRegistryPath())
    const to = resolveContainer(registry, args.to)
    const assignments = await loadAssignments()
    const prev = assignments[args.session]
    // First assignment seeds epoch 1; re-assigning a known session keeps its
    // epoch (no data movement = no fence bump).
    const epoch = prev ? prev.epoch : 1
    assignments[args.session] = { containerID: to.id, url: to.url, epoch, updatedAt: Date.now() }
    await saveAssignments(assignments)

    if (args.json) {
      process.stdout.write(JSON.stringify({ session: args.session, ...assignments[args.session] }, null, 2) + EOL)
      return
    }
    out(
      UI.Style.TEXT_SUCCESS_BOLD +
        `assigned ${args.session} -> ${to.id}` +
        UI.Style.TEXT_NORMAL +
        `  epoch=${epoch}`,
    )
  },
})

export const OrchestratorCommand = cmd({
  command: "orchestrator",
  describe: "coordinate lmcode agent containers (status, handover, assign)",
  builder: (yargs: Argv) =>
    yargs.command(StatusCommand).command(HandoverCommand).command(AssignCommand).demandCommand(),
  async handler() {},
})
