# Runbook: running & driving lmcode (dev)

How to run and test lmcode in this environment (no installed `lmcode` binary yet).

## Toolchain
- bun: `/tmp/opencode/.bun/bin/bun` (add to PATH: `export PATH=/tmp/opencode/.bun/bin:$PATH`).
- `node_modules` is installed at repo root (run `bun install` if missing).
- Run the CLI from source: from `packages/opencode`:
  `bun run --conditions=browser ./src/index.ts <args>`
  (the `--conditions=browser` matches the repo `dev` script).

## Auth (GitHub Copilot, OAuth device flow)
- lmcode reads creds from `~/.local/share/lmcode/auth.json` (data dir; renamed from opencode).
- Login: `... ./src/index.ts auth login --provider github-copilot --method 'Login with GitHub Copilot'`
  - It prompts "Select GitHub deployment type" -> choose GitHub.com (send Enter).
  - Prints `https://github.com/login/device` + a device code; user authorizes on the website.
  - Poll loop waits through `authorization_pending` (fixed in copilot.ts) until approved.
- Running an interactive prompt flow non-blocking: use tmux
  (`tmux new-session -d -s lmauth '...'`, `tmux send-keys -t lmauth Enter`, read a `tee` log).
- `auth list` shows stored credentials and the file path.

## Default model
- Set in `~/.config/lmcode/opencode.jsonc`: `"model": "github-copilot/gpt-5.4"`.
- Then `... run "<prompt>"` works with no `--model`.

## Smoke test
- `... run "Reply with exactly one word: PONG"` -> prints `PONG`, exit 0.
- `... models github-copilot --refresh` -> live entitled model list.

## Gotchas
- `/usr/local/bin/opencode` is the REAL opencode (different app) — do not confuse with our build.
- Interactive prompts (`@clack/prompts`, Effect `Prompt`) block on a TTY; drive via tmux or provide flags.
- Claude-via-copilot models 404 in this dev build (see models-and-effort.md).

## Microservice (serve) — REST, single-user, sequential
- Start: `lmcode serve --port <p> --hostname 127.0.0.1` (set OPENCODE_SERVER_PASSWORD to secure it).
- REST: `GET /session` (list), `POST /session` (create -> {id}), `POST /session/{id}/message`
  with body `{"model":{"providerID":"github-copilot","modelID":"gpt-5.4"},"parts":[{"type":"text","text":"..."}]}`
  -> blocks until the run completes, returns `{info: AssistantMessage, parts:[...]}`.
- Verified end-to-end (create session -> prompt -> assistant reply over HTTP).
- Single-user sequential: a process-global semaphore(1) serializes all execution endpoints
  (prompt/command/init/summarize/shell). Concurrent prompts QUEUE (FIFO) and run one at a time.
  abort + permissionRespond are ungated (always responsive). Subagents bypass the gate (in-process).
- Permissions are file-based (config `permission` rules + `permission_ask: deny|allow` fallback); no popup.
