# FS-DEFAULT-ACCESS: allow cross-directory filesystem access by default

Status: resolved (2026-09-11).
Reporter: lmbi.lmctl:Lead, relaying an explicit operator request.

The `ls` and `glob` tools refused cross-project reads from lmbi because default
`external_directory: ask` rules became denials. Default filesystem read/write
access should cover any directory, subject to host OS permissions. Explicit
user-configured restrictions must still apply.

Scope: lmplayer only, including legacy and V2 runtime defaults and shared
filesystem permission enforcement. Do not modify lmbi or lmctl-src.

Acceptance:

- Default agents can read and write outside the current project without approval.
- Explicit external-directory and read/edit restrictions remain effective.
- Filesystem tool checks continue to use the permission system.
- Regression tests cover defaults and explicit restrictions in both runtimes.

Initial finding: legacy `src/agent/agent.ts` and V2 core `src/plugin/agent.ts`
both set the default external-directory rule to `ask`.

Resolution: both default rules now allow external directories. Structured Linux
tools also accept external working directories by default while preserving
explicit roots and permission checks. No changes were made to lmbi or lmctl-src.

Verified: 323 targeted tests, both package typechecks, lint with zero errors,
native build, and live installed-binary ls/glob/read/write against a sibling
directory. Installed version: `0.0.0-dev-202609112004`.
Details: `durable-memory/filesystem-default-access.md`.
