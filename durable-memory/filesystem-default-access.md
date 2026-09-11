# FS-DEFAULT-ACCESS: cross-directory filesystem defaults

Requested by lmbi Lead on behalf of the operator (2026-09-11). Their `ls` and
`glob` calls against sibling projects were denied by the default
`external_directory: ask` rule. Changes are confined to lmplayer.

## Behavior

- Legacy and V2 built-in agent defaults now allow `external_directory: *`.
  Normal coding agents can read/write outside the project without approval.
  Read-only agents retain their edit restrictions; `secured` remains restricted.
- Tools still submit permission checks. Explicit global, per-agent, and session
  restrictions remain effective. Sensitive-file rules and OS permissions remain.
- Structured Linux tool `workdir` defaults are unrestricted when
  `tool_workdir.extra_roots` is omitted. Explicit roots remain restrictive;
  `[]` means workspace-only. External working directories now pass through the
  same `external_directory` permission check before command execution.
- Config errors propagate rather than silently falling back to permissive
  workdir defaults. No config files in other projects were changed.
- Existing running processes must restart to load the new code. Persisted or
  explicitly configured session restrictions are not erased by a default change.

## Implementation and evidence

- Defaults: `packages/opencode/src/agent/agent.ts`,
  `packages/core/src/plugin/agent.ts`.
- Workdir boundary: `packages/opencode/src/tool/linux/exec.ts` and its six
  callers (find, gh, git, rg, tar, unzip).
- Legacy regression first failed on the old default (`ask` instead of `allow`).
- 290 legacy agent/tool/permission tests and 33 core agent/config/permission
  tests pass. Both package typechecks pass. Independent reviews found no blockers.
- New integration tests exercise actual `ls`, `glob`, `read`, and `write` tools
  through the real legacy Permission service. Explicit external/read/edit/glob
  denials fail before access or mutation, and no permission prompt remains pending.
- Live source probe from an isolated temporary workspace used all four tools
  on a sibling directory and completed with `FS_DEFAULT_ACCESS_OK`.
- Native Linux build, including embedded web UI, passes its version smoke test.
  Installed binary: `0.0.0-dev-202609112004`.
- Live installed-binary probe also completed all four tools against the sibling
  directory and wrote `FS_INSTALLED_OK`. Lint reports zero errors (existing
  warnings remain).

Issue record: `backlog/filesystem-default-access.md`.
