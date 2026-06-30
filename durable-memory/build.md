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
