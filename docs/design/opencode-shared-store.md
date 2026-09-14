# Shared OpenCode storage and auth: exploratory decision

Epic #172, task #173. Design only, 2026-09-14. No implementation or live-store
migration is authorized by this document. Epic #167's provider timeout fix is
already delivered independently.

## Recommendation

Do not point today's lmplayer at the live OpenCode database. Pursue a bounded
one-way compatibility experiment on disposable copies only if the operator
accepts the maintenance cost. Recommend **OpenCode session -> lmplayer resume**
for the first supported contract. Do not promise bidirectional switching.

The payoff is preserving conversation and task context when the scheduler moves
execution between these two runtimes. Keeping the same ID is necessary but not
sufficient: message parts, tool results, project placement, attachments, pending
inputs and execution ownership must also agree. Provider account/model availability
and permission policy are separate from session portability. Model swaps do not
prove that every stored part is portable across runtimes.

A live shared file with two independently upgrading applications is not worth
shipping without a pinned compatibility matrix and a controlled migration window.
An API-mediated OpenCode-owned store is a safer long-term boundary, but requires
an upstream extension contract or a maintained adapter; it is not available merely
by changing a path. A copy/import fallback preserves context while keeping stores
isolated, but is explicitly not the requested same-file/no-reseed architecture.

## Evidence and limits

Compared lmplayer source at d30cc848a5 with upstream OpenCode tag v1.18.27,
commit 4b7e19e315cca414121ba1d61523fef74bb3ae8b, fetched read-only. Installed
OpenCode reports 1.18.27. This is a source comparison, not a certification of the
installed binary's complete schema or any live database; no credentials or live
session contents were inspected.

- Data namespaces differ: `packages/core/src/global.ts:10` selects lmplayer;
  `packages/core/src/database/database.ts:58` selects OPENCODE_DB or a
  channel-specific filename. Matching a filename alone does not select the same
  data root. Config, cache, logs and attachments need separate explicit routing.
- Opening the database currently runs migrations automatically:
  `packages/core/src/database/database.ts:37`. The migrator uses a shared
  `migration` journal, handles legacy Drizzle journals, and applies missing IDs
  (`packages/core/src/database/migration.ts:46`, `:96`). Current startup is not
  a read-only compatibility probe.
- Fork-specific `session_job` and `session_job_output_read` tables extend the
  session schema (`packages/core/src/session/sql.ts:178`); five job migration
  modules and generated schema entries differ from the upstream tag. They are
  separate tables already, but their unprefixed names and common journal are
  not a durable upstream extension namespace.
- Session ID validation is shared with SessionV2
  (`packages/opencode/src/session/schema.ts:7`); ID syntax does not establish
  transcript compatibility or cross-process ownership.
- Auth is a file, not a DB table: `packages/opencode/src/auth/index.ts:10`.
  Updates read the whole map and write it back with mode 0600 (`:75`, `:80`,
  `:88`). A shared path alone does not solve lost updates or OAuth refresh races.
- Current lmplayer initializes WAL, NORMAL synchronous mode, foreign keys and
  a 30s busy timeout, and checkpoints periodically
  (`packages/core/src/database/database.ts:27`). The inspected upstream tag
  uses a 5s busy timeout and startup checkpoint. Neither setting serializes
  semantic execution of the same session across applications.

## Ownership and extension contract

OpenCode owns all base tables, base indexes, base triggers and base migrations.
Lmplayer compatibility mode must bypass its bundled base migrator completely.
Only a designated migration command may run OpenCode upgrades, after both
applications have stopped accepting work and drained sessions. A lock honored
only by lmplayer cannot restrain an unmodified OpenCode auto-migrator: supported
operation therefore requires pinned binaries and managed launch/upgrade policy.
Unmanaged simultaneous upgrades are outside the supported contract.

Lmplayer owns only `lmplayer_*` tables and `lmplayer_schema_migration`, with
checksummed ordered migrations and a compatibility manifest. No extra columns
on upstream tables, no triggers on them, and no changes to the upstream journal.
Examples: session extension metadata, job state/output references, notification
claims and provenance. References to upstream session IDs should be logical
references initially, not foreign keys that make upstream table reconstruction
or deletion depend on extension schemas. Explicit orphan reconciliation follows
base-session deletion; it must not delete base records.

Existing unprefixed job tables need an explicit conversion in a disposable
migration rehearsal, not blind renaming in a live fleet. Extension tables reduce
schema coupling but do not isolate corruption, disk-full failures, or accidental
DDL within a shared SQLite file.

## Version skew and compatibility direction

Before any write, open through a dedicated read-only preflight path that does
not initialize normal services. Check base migration IDs/checksums, required
columns/indexes, serialization version, extension version, and declared runtime
pair. Semver alone is inadequate. Unknown/newer schemas fail closed with a
specific unsupported-store error; offer read-only inspection or an isolated
copy, never silently reseed or automatically downgrade the shared file.

The first contract accepts completed, idle OpenCode sessions with supported
parts and available assets. Reject active turns, pending tool calls, unresolved
inputs, missing attachments and unknown part variants before writing. Preserve
IDs and ordering; record handoff provenance in an extension table. Release the
OpenCode executor before admitting lmplayer work. SQLite locks protect writes,
not two models independently continuing the same transcript. A single scheduler
must enforce exclusive session execution; unmanaged OpenCode TUI resume while
lmplayer owns the session is unsupported until both runtimes honor one fence.

One-way means OpenCode-origin history can be continued by lmplayer. After
lmplayer-specific history is written, resuming in unmodified OpenCode is not
promised. Bidirectional support requires round-trip tests for every extra part,
notification/job representation, compaction and deletion behavior, plus shared
execution fencing. This is a separate project, not a free consequence of tables.

## Auth

Select an explicit OpenCode credential source; do not symlink whole data/config
homes. Keep provider aliases, OAuth issuer/client/account semantics and refresh
behavior in the compatibility matrix. Never copy secrets into extension tables,
logs, task notes or backups without the existing secret-protection policy.

Use a single credential writer/refresh authority. Atomic file replacement prevents
partial files but does not prevent two read-modify-write operations losing keys,
or two processes rotating the same refresh token. A lock needs both applications
to cooperate. Until OpenCode exposes that cooperation, shared OAuth operation
requires exclusive runtime handoff, refresh completion, and credential reload;
concurrent autonomous refresh is not supported. Read-only reuse of compatible
API credentials is cheaper but is not equivalent to full shared OAuth support.

## SQLite concurrency and recovery

Same host and local filesystem only. WAL permits readers alongside a writer,
but still only one writer at a time; long readers can delay checkpoints.
Use short transactions, no provider/network waits inside transactions, bounded
busy handling with jitter, and retries only for operations whose idempotency is
established. Surface exhausted busy budgets. Verify actual PRAGMA values on each
connection; do not assume one application's busy timeout configures the other.
[SQLite WAL](https://sqlite.org/wal.html).

Before migrations, drain both runtimes and take a consistent online backup or
quiesced snapshot including referenced assets. Do not copy only a live .db file
while ignoring its WAL. Restore-test the backup, retain the prior executable pair
and manifests, and validate integrity plus representative transcript reads on a
copy. On failure keep writes disabled; restore the whole compatible store and
assets, not selected base tables. Restoring rolls back both tools' later writes,
so record the recovery point and obtain an explicit operational decision before
restoring a live fleet. [SQLite backup API](https://sqlite.org/backup.html).

Pilot with disposable sessions, then an opt-in noncritical store. Never switch
all fleet paths by default. Keep current isolated stores available as rollback
sources; no automatic merging of divergent histories. Read-only mode is useful
for diagnosis, but it cannot make a corrupted file trustworthy.

## ACP relationship and effort

Task #159's reviewed design explicitly leaves native storage with provider
readers and treats ACP session IDs as opaque. Preserve that boundary. This design
could allow lmplayer/OpenCode definitions to reuse a versioned native reader and
store locator; it does not give Hermes the same persistence or remove its reader.
Do not make #159 or epic #111 depend on #172. Source:
`/home/mma/repos/lmctl-src/backlog/DESIGN-common-acp-provider.md`, Boundary section.

Planning estimate, not a commitment: 2-4 engineer-days for the disposable-copy
compatibility spike; 2-4 engineer-weeks for a supported one-way adapter, migration
separation, auth handoff and recovery tests; ongoing work for every supported
OpenCode schema change. Bidirectional support has substantially greater and
currently unbounded scope until the part/ownership matrix exists.

## Proposed decision gates (no build authorized)

1. Inventory a pinned pair using synthetic sessions and schema-only fixtures.
   Deliver a part/asset/migration compatibility matrix. Reject the approach if
   preserving IDs requires rewriting upstream semantics or losing tool history.
2. Demonstrate one-way resume on copies: same ID and history, exactly one new
   turn, no writes on unsupported versions, no base DDL from lmplayer.
3. Kill each migration/refresh/handoff phase in tests. Prove consistent restore,
   no duplicate execution and no credential-map loss. Test contention, disk-full,
   upstream rename/drop, unknown parts and missing assets explicitly.
4. Only after review choose whether the payoff justifies a managed pilot. Any
   production migration, shared-auth rollout or bidirectional expansion needs a
   separate implementation task and explicit operator authorization.

Design acceptance: all six epic questions are answered above; recommendation and
limitations are explicit. Runtime compatibility tests are proposed, not executed.
