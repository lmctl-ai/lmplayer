# Bash-Free Validation Finding

## Summary

- Worker session: `ses_0da68a0bcffeGp4kpBEh0XFMVs`
- Worker branch: `qa-wc-tool`
- Team branch: `team-qa-validation`
- Worker task: add a structured Linux `wc` tool, register it, add targeted tests, and commit using bash-disabled lmcode.
- Result: completed real code and committed without bash tool usage.

## Evidence

- Worker harness disabled bash with worktree-local `.opencode/opencode.jsonc` using `tools.bash: false` and `permission.bash: "deny"`.
- Worker completed code changes using structured tools (`read`, `grep`, `apply_patch`, `git`) and did not invoke the bash tool in the captured session output.
- Worker commit: `bff02cacf29f5b4485729136b503007e3efae13a` (`feat(opencode): add structured wc tool`).
- Integrated team commit: `91018ce3a` (`feat(opencode): add structured wc tool`).

## Verification

- Worker completed `git diff --check` using the structured `git` tool.
- Worker could not run `bun test test/tool/linux/linux.test.ts` or `bun typecheck` because bash was disabled and no structured Bun/test runner tool exists.
- Team lead verified after integration from `packages/opencode`:
  - `bun test test/tool/linux/linux.test.ts`: 19 pass, 0 fail.
  - `bun typecheck`: passed.

## Tool Gaps

- Missing structured `bun` tool or equivalent trusted test-runner tool. This blocked the worker from running repo-approved verification commands (`bun test`, `bun typecheck`) while bash was disabled.
- Installing dependencies still required host-side raw command execution by the lead (`bun install`) because there is no structured package-manager install tool in the secured set.
- The worker could inspect git diffs and commit with structured `git`, but broader command execution remains unavailable by design; verification workflows need an explicit trusted-execution policy before wrapping `bun`, `npm`, `pnpm`, `yarn`, or similar tools.

## Recommendations

- Add a narrowly scoped structured `bun` tool, or a safer repo-script/test-runner abstraction, that can run declared project commands such as `bun test <path>` and `bun typecheck` from an allowed package directory.
- Treat package-manager and test-runner tools as a policy decision because they execute repository code; do not add generic shell-equivalent execution without explicit trusted-execution semantics.
- Keep structured `wc` as a useful read-only CLI addition if the meta-lead accepts the validation code; it exercised file creation, registration, tests, git staging, and commit without needing raw bash.
