# Remote-operator poll channel (prototype) — CLIENT-ONLY / OUTBOUND-ONLY

Delivered on branch `remote-poll-channel` (pushed to `lmplayer`), commit `4ea42dbab`
(`feat(opencode): remote-operator poll channel prototype`). Adversarially reviewed by Reviewer1 (gpt-5.5) →
APPROVE after one fix loop. Coder = claude-sonnet-5.

## Why / constraint
lmplayer is a CLIENT ONLY, OUTBOUND ONLY (laptop/deep-VM behind NAT) — it CANNOT accept inbound connections. So a
remote operator cannot POST to us. Instead a poll loop lives INSIDE the lmplayer process and reaches OUTBOUND:
`GET <url>?after=<seq>` to fetch instructions, inject each as a user prompt, then `POST <url>/response` with the
reply. One session = one poller; it stops when the process exits.

## The key reuse (how the poller injects into the live session loop)
Both the TUI and `run` submit a typed user prompt via the SDK method `client.session.prompt(...)`:
- TUI: `packages/tui/src/component/prompt/index.tsx:1091`
- run: `packages/opencode/src/cli/cmd/run.ts:864`
- → `POST /session/:id/message` → handler `.../httpapi/handlers/session.ts:405` → `SessionPrompt.prompt`
  (`packages/opencode/src/session/prompt.ts:1053`). The SYNC `/message` call BLOCKS until the turn completes and
  RETURNS the assistant message `{ info, parts }` (reply = text parts). It passes through the process-global FIFO
  execution gate (`packages/opencode/src/server/execution-gate.ts:16`), so an injected prompt is serialized
  "in turn" with user prompts — NOT an interrupt. This IS the queue semantics for the legacy path (the live
  TUI/run path today; V2 `SessionV2.prompt` + durable `session_input` steer/queue is wired in packages/core but
  NOT what the default TUI/run drive).
The poller reuses this exact call via a `submit` seam = `sdk.session.prompt(..., { throwOnError: true })`. It never
appends messages directly or uses a parallel admission path.

## Files (packages/opencode)
- `src/remote/channel.ts` — `RemoteChannel`: `Channel<R>` interface (`poll(after)`, `respond(id,payload)`),
  `Instruction {id,seq,text}`, `Response {detail,text}`, `Detail = full|delta|summary`, `RemoteChannelError`
  (TaggedError). Impls: `httpMailbox({url,token?})` (HttpClient, bearer, `HttpClient.filterStatusOk` on both
  verbs, safe `responseUrl()` join) and `stub()` (in-memory Ref; `enqueue`/`posted`/`responses` for tests).
  Websocket seam documented (same interface; poll drains a buffered queue, respond sends a frame).
- `src/remote/poller.ts` — `RemotePoller`: `drainOnce` (poll → per-instruction submit → respond → advance cursor;
  a failed turn posts `ERROR: <msg>` and the cursor ALWAYS advances so a poison instruction can't wedge the loop),
  `run` (resident loop: `Effect.repeat(Schedule.spaced)` + `forkScoped`, torn down on scope close), `formatReply`
  (full = all text parts; delta = full for now [placeholder]; summary = truncate 280), `Submit` seam type.
- `src/cli/cmd/run.ts` — hidden flags `--remote-poll <url>` `--poll-token <t>` `--poll-interval <ms=2000>`
  `--response-detail <full|delta|summary=full>`; guarded `runRemotePoll(sdk)` branch before each `execute(sdk)`
  (reuses `session()`/`pickAgent()`), resident until SIGINT, `FetchHttpClient.layer` provided locally. Absent
  `--remote-poll` ⇒ ZERO behavior change. `--mini` passthrough disables it.
- `test/remote/poller.test.ts` — 5 tests, incl. the round-trip proof against the fake-LLM harness.

## Round-trip proof (test/remote/poller.test.ts)
Uses the in-process fake-LLM harness (pattern from `test/server/httpapi-sdk.test.ts:773` `withFakeLlm`;
`test/lib/llm-server.ts` `llm.text(...)`; `test/lib/test-provider.ts`; `test/fixture/fixture.ts`
`tmpdirScoped`). Round-trip test: `llm.text("ACK: instruction handled")` → create session (allow-all perm) →
`stub.enqueue({id:"i1",seq:1,text:"do the thing"})` → `RemotePoller.drainOnce` with `submit` = REAL
`sdk.session.prompt(...)` → asserts the stub got one response `{instructionId:"i1", text⊇"ACK..."}`, cursor→1, and
`llm.inputs[0]` ⊇ "do the thing" (proves the injected text reached the model as a user prompt). NOT an echo.
`bun run typecheck` clean; `bun test test/remote/poller.test.ts` → 5 pass. Full monorepo `turbo typecheck` green
(pre-push hook).

## Flagged decisions / prototype limitations
- Injection point = the `run` command (headless resident poller), not the TUI. Chosen because `run` already has
  the in-process SDK client + resolved sessionID and is fully testable; the module is TUI-ready (SDKProvider
  seam at `packages/tui/src/context/sdk.tsx:119-139` uses the AbortController+onCleanup idiom). Flags exist only
  on `run` for now.
- `runRemotePoll` provides its own `FetchHttpClient.layer` (not the app's shared HttpClient — no proxy/retry cfg).
- SIGINT-only teardown; the resident `run` loop has no CLI-level test (only `drainOnce`/`formatReply` covered).
- `after` cursor is in-memory (resets on restart) — fine for a prototype.
- `delta` response detail == `full` for now (placeholder for future streaming deltas / MCP-style negotiation).

## Gotcha discovered: copilot Claude models must be DECLARED for lmctl
`github-copilot/claude-sonnet-5` worked via the dev-source CLI but `lmctl seed`/`refresh` 404'd until it was added
to `~/.config/opencode/opencode.json`'s `github-copilot.models` (mirror the `claude-opus-4.8` block). GPT/Gemini
resolve config-free; copilot Claude + custom providers need the declaration. `~/.config/lmcode/opencode.jsonc`
is empty; lmctl's installed binary reads `~/.config/opencode/opencode.json`.
