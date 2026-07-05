# build notes

## XDG app directory name

`packages/core/src/global.ts:10` — `const app` is THE single source of truth for
all user-level XDG dirs: config, data, cache, state, tmp, plus the derived
bin/log/repos paths. It feeds `xdgConfig/xdgData/xdgCache/xdgState` joins and
`os.tmpdir()`. Change it in one place to relocate everything.

It is now `"lmcode"` (was `"opencode"`), so user dirs are `~/.config/lmcode`,
`~/.local/share/lmcode` (auth.json, storage, sqlite), `~/.cache/lmcode`,
`~/.local/state/lmcode`, and `$TMPDIR/lmcode`.

Not changed (deliberately, not on-disk XDG paths): package names, Effect service
tags (`@opencode/...`), provider ids, CLI binary name `opencode`, `OPENCODE_*`
env vars, config file basenames `opencode.json`/`opencode.jsonc`, project-level
`.opencode/` dir convention, and `packages/opencode/src/config/managed.ts`
(`ProgramData/opencode`, separate follow-up).

## STATUS (toolfix team-toolfix, 2026-07-05)

- Worker session: `ses_0cf5d1fe6ffebVAfvJJgQEUsg5` on `github-copilot/gpt-5.3-codex`.
- Branch: `team-toolfix` (off `dev`) in worktree `/niceapps/mma/oc/lmcode-wt/team-toolfix`.
- Completed fixes and commits:
  - `141a37ee2` `fix(opencode): allow git switch create flag`
  - `72d2caf98` `fix(opencode): classify git branch inspection as read`
  - `76436b9a1` `fix(glob): honor gitignore by default`
  - `39465fa99` `fix(opencode): support extra workdir roots`
  - `fc4381e99` `fix(opencode): honor configured git workdir roots` (lead-requested follow-up after review found git path omission)
- Verification rerun by lead:
  - `packages/opencode`: `bun test test/tool/linux/git.test.ts test/tool/glob.test.ts test/tool/linux/exec.test.ts test/tool/linux/gh.test.ts test/tool/linux/find.test.ts test/tool/linux/rg.test.ts test/tool/linux/tar.test.ts test/tool/linux/unzip.test.ts` (120 pass)
  - `packages/core`: `bun test test/filesystem/search.test.ts` (4 pass)
  - `packages/opencode`: `bun run typecheck` (pass)
  - `packages/core`: `bun run typecheck` (pass)
- Regeneration check: no Protocol/HttpApi surface change; `bun run generate` not needed.
- Escalations: none. Config field added as minimal internal surface: `tool_workdir.extra_roots`.
