# Design: lmcode as Orchestrated Agent Containers (ORGANIZE + handover/failover + orchestrator)

Status: DRAFT for team design review. Author: Lead. Operator directive (this session).

## Vision (operator)
- lmcode is a CONTAINER = one `lmcode serve` microservice (agent runtime).
- Containers can talk to each other over the local network.
- Replace session "/compact" with "ORGANIZE": not lossy summarization — instead an idle-time LLM
  pass UPDATES a per-session durable-memory/ directory; the next session context becomes
  `durable-memory/index.md` + the last N messages. Organize makes a session's state PORTABLE.
- Portable state = durable-memory/ + last N messages => enables drainage / handover / failover of a
  session from one container to another (lightweight, vs replaying full history).
- Design a LIGHTWEIGHT ORCHESTRATOR that coordinates these agent containers.

## Key research findings (what exists vs to build)
- ORGANIZE seam (live V1 path = SessionPrompt.loop):
  - Compaction trigger: overflow predicate `overflow.ts:isOverflow` (config `compaction.auto/reserved`)
    and manual via `POST /:id/summarize` -> `compactSvc.create` + `loop`.
  - Compaction action today: `compaction.process` (compaction.ts:356) generates a lossy SUMMARY assistant
    message via an LLM run using SUMMARY_TEMPLATE.
  - Next-context projection: `MessageV2.filterCompacted` (message-v2.ts:521) = [compaction-user, summary,
    ...retained tail from part.tail_start_id..., continue-user]. THIS is where summary-head -> index.md.
  - Idle hook: `run-state.ts:60` onIdle, or fork like `prompt.ts:1337` (compaction.prune forked at idle),
    or subscribe `SessionStatus.Event.Idle` (status.ts:43).
  - V2 analog (cleaner long-term): `compaction` message `{summary, recent}` (session-message.ts:192) is
    already "index.md + last N"; renderer to-llm-message.ts:147, selection history.ts:13. Map summary<-index.md.
  - System-context injection: register a `core/durable-memory` Context Source modeled on
    `instruction-context.ts:29` whose load reads durable-memory/index.md (re-baselined at each Context Epoch).
  - NO per-session memory/notes concept exists today. Storage: natural home is a per-session dir under
    Global.Path.data (e.g. data/session/<id>/durable-memory/).
- Inter-instance (mostly EXISTS):
  - Transport+auth: `createOpencodeClient({baseUrl, directory, headers})` + `ServerAuth.headers` (Basic auth
    via OPENCODE_SERVER_USERNAME/PASSWORD; also ?auth_token= for SSE). `attach <url>` is the canonical remote path.
  - Typed API + OpenAPI: `Server.openapi()`; full InstanceHttpApi groups.
  - Cross-instance events: SSE `GET /global/event` + `events.replay(..., {ownerID, strictOwner})`;
    durable event `owner_id` + `claim` = ownership fencing (event.ts:254,291,525).
  - Remote proxy: WorkspaceRoutingMiddleware + HttpApiProxy (flagged experimentalWorkspaces).
  - HANDOVER/FAILOVER already exists (experimental): `control-plane/workspace.ts:sessionWarp` moves a session
    to another instance via `/sync/replay` (full event-log) + `/sync/steal` (ownership) + `claim`.
  - `Target = {type:"local",directory} | {type:"remote",url,headers}` (control-plane/types.ts:30).
  - MISSING: peer DISCOVERY (mDNS publish exists, no browse; no instance registry). Remote-capable Location
    (Location.Ref is {directory, workspaceID} only). Session placement is process-local only
    (`session/execution/local.ts:10` "Future remote placement belongs here"). Post-crash recovery deferred.

## Proposed design (phased)

### Phase O — ORGANIZE (foundation; self-contained; do first)
1. Per-session durable-memory dir: `Global.Path.data/session/<sessionID>/durable-memory/` with `index.md`
   (+ optional topic files). Add a small accessor (path resolve, read index, write index).
2. Organize pass (replaces the summary generation at the compaction trigger): when a session would compact,
   run an LLM "organize" turn that UPDATES durable-memory/index.md (curate durable knowledge: goals,
   decisions, files, open threads — like the SUMMARY_TEMPLATE but APPENDED/MERGED into index.md, not a
   throwaway summary). Keep the existing tail selection (tail_start_id / tail_turns) as "last N messages".
3. Next context = index.md (as system context via a `core/durable-memory` Context Source) + last N messages.
   V1: in `filterCompacted`, replace the summary-message head with the durable-memory index injected as an
   instruction/context source; keep the retained tail. (Or keep a compaction marker whose body is index.md.)
4. Run organize on IDLE (forked at the onIdle/prune seam) so it doesn't block the user; trigger also on
   overflow (must organize-before-continue when over budget).
5. Config: reuse `compaction.*` (auto/tail_turns/reserved) + add `organize: { last_n }` or map tail_turns.
   Keep `/compact` command + `/summarize` endpoint but rename semantics to "organize" (alias kept).
OPEN: V1 vs V2 implementation (V1 is live; V2 is cleaner). Recommend V1 first (live path), mirror to V2 later.
OPEN: merge strategy for index.md (append vs full rewrite each organize) — recommend LLM rewrites index.md
to a bounded size (it's the curated brain), with topic files for overflow.

### Phase H — Portable session + lightweight handover/failover
1. Portable session bundle = durable-memory/ + last N messages + session metadata (id, agent, model,
   location/dir). Small and replayable — much lighter than full event-log sync.
2. Handover (drainage): orchestrator tells container A to export the bundle (HTTP), creates/resumes the
   session on container B from the bundle (index.md as system context + tail as seed messages). Reuse
   `Target`/SDK transport + `claim` for ownership fencing. Could reuse `/sync/*` minimally OR a new lighter
   `/session/:id/export` + `/session/import` pair carrying the bundle.
3. Failover: if container A dies, the last organized bundle (durable-memory + tail, persisted) lets B resume
   the session. Requires the bundle to be durably persisted (it is, on disk) and reachable (orchestrator-held
   or replicated). Ownership via event `claim`/`owner_id` prevents split-brain.
OPEN: reuse experimental sessionWarp/sync vs a new lightweight export/import. Recommend a NEW lightweight
bundle export/import (durable-memory + tail), since the operator explicitly wants lightweight, not full replay.

### Phase R — Lightweight orchestrator
1. A small coordinator (a mode of lmcode, e.g. `lmcode orchestrator` / `lmcode serve --role orchestrator`,
   or a separate tiny service) that:
   - Knows the container set (discovery): start with a STATIC config/registry of container URLs (+auth);
     add mDNS browse later (publish exists). For now, local network static list is fine (operator said "for now").
   - Tracks session->container assignment and container health (heartbeat via GET /global/event or a health ping).
   - Assigns new sessions to a container; on idle/handover request, drains a session; on container failure,
     fails the session over to another container from its last organized bundle.
   - Single-user + sequential per container (we already serialize per container via SQ1).
2. Built on existing primitives: SDK transport+auth, Target, event ownership/claim. Keep it lightweight:
   in-memory assignment map + durable bundle on disk + a simple REST control surface
   (`POST /orchestrator/assign|handover|failover`, `GET /orchestrator/status`).
OPEN: is the orchestrator a separate process or a role of an lmcode container? Recommend a separate light
process (or a role) so it can outlive/monitor containers (failover needs an external coordinator).
OPEN: discovery — static list now; mDNS browse later.

## Sequencing recommendation
Phase O (organize) first — it's the foundation, self-contained, and immediately valuable (better than lossy
compaction). Then H (portable bundle + handover) which depends on O's bundle. Then R (orchestrator) which
drives H. Each phase ships in reviewable slices via Coder->Reviewer->commit.

## Top open questions for reviewers + operator
1. ORGANIZE on V1 (live) vs V2 (clean) — start V1?
2. index.md merge strategy (LLM rewrites bounded index vs append) and where last-N tail comes from (reuse tail_turns?).
3. durable-memory storage: per-session dir under Global.Path.data — ok? (vs a DB table.)
4. Handover transport: NEW lightweight bundle export/import vs reuse experimental sessionWarp/sync. (Recommend new lightweight.)
5. Orchestrator: separate process vs lmcode role; discovery static-now vs mDNS-later.
6. Is the existing per-session "durable-memory" the SAME concept as our team's repo durable-memory/, or a new per-session brain? (operator said per-session "internal durable-memory directory".) -> per-session, new.

## REVIEW CORRECTIONS (all 3 reviewers; supersede conflicting draft notes)
Phase O (Reviewer1):
- Inject index.md as system context at the V1 REQUEST-ASSEMBLY seam `packages/opencode/src/session/prompt.ts:1256-1285`
  (where `system` is built), NOT `filterCompacted` (that only reorders messages).
- KEEP the existing summary/compaction-marker + `tail_start_id` machinery (V1 infers compaction state from the
  assistant summary message: compaction.ts:62-78, message-v2.ts:531-569). AUGMENT, don't replace, in slice 1.
- Organize must run SYNCHRONOUSLY in the overflow/compaction path (idle-only breaks overflow recovery);
  idle organize is an additional pass, not the only one.
- index.md = bounded REWRITE each organize (not append-only). Keep it structured + bounded; spill to topic files later.
- V2 compaction schema is `packages/schema/src/session-message.ts:191`; lowering `core/src/session/runner/to-llm-message.ts:147`.
- SMALLEST FIRST SLICE (O1): per-session durable-memory/index.md accessor + inject index.md into the V1 system
  prompt (prompt.ts:1256-1285), leaving summary/tail unchanged. Then O2: organize LLM pass writes index.md at compaction.

Phase H/R ownership fence (Reviewer3 — THE crux; resolves the draft contradiction):
- The lightweight bundle path BYPASSES the event-log replay that propagates owner_id across instances, so
  owner_id/claim ALONE does NOT prevent split-brain for the lightweight path.
- FENCE = orchestrator-held single authoritative assignment + MONOTONIC EPOCH/LEASE per session. export bumps the
  epoch; import adopts it. EVERY container validates its epoch with the orchestrator BEFORE provider work AND
  BEFORE writing the bundle (index.md) back. A revived/stale-epoch container MUST refuse to run/write.
- Bundle is LOSSY BY DESIGN (last N + index.md): failover loses any in-flight not-yet-organized tail. State it.
- De-risk FIRST (before polishing O): a two-container handover walking skeleton WITH the epoch lease, including a
  deliberate "revive the source" test proving the stale-epoch container refuses to resume.

Orchestrator (Reviewer3): SEPARATE process (same binary, e.g. `lmcode serve --role orchestrator`), own failure
domain (must outlive a dead container). Minimal = durable assignment map {sessionID->{url,epoch}} + health (reuse
SSE heartbeat) + epoch/lease + assign/handover/failover triggers. No load balancing.
Discovery: static {id,url,headers} list now; mDNS browse drop-in later; never conflate configured with reachable.

Handover transport (Reviewer2/3): build NEW lightweight `POST /session/:id/export` + `POST /session/import`
(metadata + index.md + last-N tail); import = factory that writes the per-session dir + persists tail as initial
history + registers in SessionStore + claims ownership. Graceful drain (finish current turn, reject new prompts,
then export). Import idempotent by sessionID. Do NOT reuse heavy sessionWarp/sync transport; steal only its fencing idea.

## DECISION (Lead): implement Phase O slice O1 first (safe, self-contained), then O2, then de-risk H with the
## epoch-lease handover skeleton, then R. Operator: confirm direction or redirect.

## PROGRESS (committed)
- O1 (5c19b536c): per-session durable-memory accessor (`packages/opencode/src/session/durable-memory.ts`,
  <data>/session/<id>/durable-memory/index.md) + inject index.md into V1 system context at prompt.ts:1256-1278.
  Proven: a session with index.md "codeword BANANA42" answered BANANA42.
- O2 (2312506dd): at each compaction (manual /summarize + auto-overflow) a FORKED, per-session-SERIALIZED
  one-off LLM "organize" turn rewrites a bounded curated index.md (merge prior+recent, drop stale). Additive:
  summary/compaction/tail untouched. Proven: /summarize wrote index.md (make ship/Dana), later turn used it;
  two back-to-back /summarize -> single consistent index.md (no clobber).
- Phase O foundation is functional. index.md is written at compaction and injected every turn.

## REMAINING PLAN (for continuation — well-specified)
- O3 (optional, riskier): make index.md the actual context-REDUCER (next context = index.md + last-N tail;
  reduce/remove the lossy summary HEAD while keeping the compaction MARKER so projection still finds the tail
  start — Reviewer1: keep marker, change content). Organize MUST be synchronous-before-continue on overflow then.
- H (handover/failover): lightweight `POST /session/:id/export` (bundle = metadata{id,agent,model,directory} +
  index.md + last-N tail) + `POST /session/import` (factory: write per-session dir, persist tail as initial
  history, register in SessionStore, CLAIM ownership). Graceful drain (finish turn, reject new prompts, export).
  Import idempotent by sessionID. THE FENCE (Reviewer3, critical): orchestrator-held monotonic EPOCH/LEASE per
  session; export bumps epoch, import adopts it; every container validates epoch with orchestrator BEFORE
  provider work AND BEFORE writing index.md back; a revived/stale-epoch container REFUSES. De-risk FIRST with a
  two-container handover walking skeleton + a deliberate "revive the source -> refuses to resume" test.
- R (orchestrator): SEPARATE process (own failure domain). Minimal = durable assignment map {sessionID->{url,epoch}}
  + health (reuse SSE /global/event heartbeat) + epoch/lease + assign/handover/failover. Discovery: static
  {id,url,headers} list now (mDNS browse later). Build NEW lightweight export/import; do NOT reuse heavy
  sessionWarp/sync transport (steal only its fencing idea). Bundle is LOSSY BY DESIGN (failover loses in-flight
  not-yet-organized tail) — accepted, state it.
- Sequencing: O done -> de-risk H fence (walking skeleton + revive test) -> R orchestrator. Each as a reviewed slice.
