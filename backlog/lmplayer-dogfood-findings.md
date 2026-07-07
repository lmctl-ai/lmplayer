# lmplayer dogfood findings

Real lmplayer/lmcode frictions surfaced while using lmplayer to modify lmcode itself.

## Cycle 2026-07-06: structured JS/TS eval tool

- **P2: Worker model stopped after recoverable TypeScript/test-layer errors.** A `github-copilot/gemini-2.5-pro` worker initially implemented the eval tool with a temp file and over-mocked Effect services, then stopped with "having trouble" instead of continuing to inspect nearby tests. A tighter follow-up prompt recovered the task. Impact: workers may prematurely abandon small tasks after local type errors. Suggested improvement: better self-recovery guidance or automatic nearby-pattern search after repeated typecheck failures.
- **P1 duplicate: structured `git` workdir rejects approved worker worktrees.** Lead-side structured `git` calls against `/niceapps/mma/oc/lmcode-wt/shell-eval` failed with `resolves outside the workspace root`, even though the dogfood brief explicitly requires worker worktrees outside the main checkout. This forced raw shell git commands for inspection. This matches existing `lmcode-dogfood-findings.md` P1 external-workdir issue.
- **P2: structured `git` tool argument schema is easy for workers to misuse.** The worker repeatedly called the structured `git` tool with malformed inputs (`args[0]`, `args` as string), received schema errors, then fell back to raw bash `git add .`/`git commit`. Impact: tool schema presentation does not reliably guide models into the expected `{ args: string[] }` shape. Suggested improvement: clearer tool examples or adapter accepting the common indexed argument object shape.
- **P3: Shell prompt quoting still bites orchestration commands.** The lead resumed the worker via a dense `bun run ... "prompt"` shell command containing backticks around an import statement; Bash evaluated the backtick command and printed `/bin/bash: line 1: import: command not found` before launching lmplayer. The prompt still mostly worked, but this is exactly the shell-quoting fragility the new eval tool targets. Suggested improvement: structured `run`/resume helper that passes prompt text as argv/file without shell interpolation.
- **P3: Full package test command is too blunt for workers.** The worker ran `bun typecheck && bun test`; typecheck passed, but the full suite hit unrelated failures and a 120s shell-tool timeout. The targeted eval test was green. Impact: full-suite noise can obscure task verification and wastes shared-host capacity. Suggested improvement: task guidance or tooling to prefer package typecheck plus targeted tests unless explicitly asked for full suite.
- **Positive: tight follow-up prompts recovered the worker and produced a clean branch.** After the initial failure, the same session completed implementation, targeted tests, and two commits. This validates resumable worker sessions for dogfood loops.

### Task Result

- Branch: `shell-eval`
- Worker: `ses_0c723eac0ffeNwiHRlPbB4jUZk`
- Model: `github-copilot/gemini-2.5-pro`
- Commits: `39f39b214955bba535f97f2ddb5af03dd88dd94d`, `50d8b61984bb08d964a11720ace542cddfa3ecd4`
- Verification: `bun run typecheck` and `bun test test/tool/linux/eval.test.ts` from `packages/opencode`

## Cycle 2026-07-06: structured session inspect tool

- **P1 duplicate: structured `git` workdir rejects approved worker worktrees.** Lead-side `git status` and `git log` calls against `/niceapps/mma/oc/lmcode-wt/session-tail` failed with `resolves outside the workspace root`, despite the dogfood workflow requiring worker worktrees there. I fell back to raw `bash` git inspection. Same root issue as prior cycles: structured repo tools need an approved external-root/worktree allowlist.
- **P3: Worker output logs are still too bulky for lead review before the new tool lands.** The worker completed successfully, but the raw JSONL stream exceeded tool output limits and was saved to an opaque file path. The useful final summary was recoverable from the truncated stream, but reviewing intermediate behavior still required scanning dense metadata-rich events. This validates the value of the new compact `session_inspect`/tail helper.
- **P3: lmchat file upload API is under-documented and hard to drive from tools.** The required metadata shape was discovered by trial (`name`, `content_type`, `size`); hyphenated filenames were rejected as `filename_invalid`; missing `size` returned `size_invalid`; and the read-only structured `curl` tool cannot perform the presigned multipart upload. I had to create a temporary Bun script to complete the S3 form POST.
- **P3: failed lmchat upload reservations are confusing.** A metadata request returned seq `17` and presigned fields, but because the S3 upload was not completed, `DELETE /rooms/lmplayerdev/files/17` returned `file_not_found`. This is understandable backend behavior, but it is awkward for cleanup/retry automation.
- **Positive: `github-copilot/claude-sonnet-4.6` completed this small Effect/tool task end-to-end.** It implemented the tool, recovered from a missing `SessionProjector` test-layer dependency by finding a nearby pattern, ran targeted tests plus typecheck, and committed without follow-up.

### Task Result

- Branch: `session-tail`
- Worker: `ses_0c6bb6321ffeYBN0Ti1h7m56CT`
- Model: `github-copilot/claude-sonnet-4.6`
- Commit: `a2469d702 feat(tool): add session_inspect tool for listing and tailing sessions`
- Verification: `bun typecheck` and `bun test test/tool/session-inspect.test.ts` from `packages/opencode` (worker and lead re-run both passed)
