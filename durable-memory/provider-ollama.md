# Config-free Ollama + conditional chat-only + verbose LLM logging

Three shipped slices (pushed to lmplayer dev): commit `108b8bfdf` (Slice 1+3)
and `788cc54fc` (Slice 2). Coder = sonnet-5, Reviewer1 = gpt-5.5 (adversarial,
APPROVE after a fix loop). All offline-tested; the LIVE ollama round-trip is
BUILT-BUT-UNTESTED (no ollama on the build host) — see the handoff at the end.

## Slice 1 — config-free `ollama/<model>` (no opencode.json, no API key)
Mirrors how `github-copilot/<id>` runs config-free. Ollama is NOT in the
models.dev catalog (only `ollama-cloud`, which needs `OLLAMA_API_KEY` and points
at ollama.com), so lmplayer seeds its own built-in provider.

All in `packages/opencode/src/provider/provider.ts`:
- Pure helpers (exported, unit-tested): `parseOllamaModel(modelID, env?)`,
  `ollamaModel(modelID, env?, baseURLOverride?)`, `normalizeOllamaBaseURL(host)`.
- Extended-name scheme (host precedence high→low): (1) in-name `@host` suffix,
  e.g. `ollama/qwen2.5@192.168.1.5:11434` (`@` is safe — ollama tags use `:`,
  namespaces use `/`, never `@`); (2) `OLLAMA_HOST` env (ollama's own var);
  (3) `http://localhost:11434` default. Any host form is normalized to an
  OpenAI-compatible `/v1` base.
- Seeding block (in the InstanceState.make closure, just before the per-provider
  pruning loop): seeds provider `ollama` (source "custom", `@ai-sdk/openai-compatible`,
  no key) with curated models `qwen2.5, qwen2.5-coder, llama3.2, llama3.1, mistral`.
  Gated by `isProviderAllowed(ollama)` and only when it has no models yet, so:
  no-config → localhost provider; config `provider.ollama` with baseURL + no
  models → seed those models at THAT baseURL; config with models → untouched;
  disabled/enabled-excluded → not seeded.
- `getModel` model-absent branch synthesizes ANY other tag on demand
  (`qwen2.5:7b`, `deepseek-r1`, `@host` forms), honoring a configured baseURL.
  NOTE: the provider-ABSENT branch does NOT synthesize (Reviewer1 blocker fix) —
  a disallowed ollama must 404 like any other, not bypass `disabled_providers`.
- `resolveSDK` baseURL `iife`: ollama-only branch makes per-model `model.api.url`
  win over the provider-level `options.baseURL` (needed for `@host`). Every
  other provider's ternary is byte-identical to before.
- `defaultModel` auto-pick EXCLUDES the auto-seeded ollama (a user with no real
  provider still gets `NoProvidersError`, not a silent default to a maybe-down
  local daemon); a user-configured ollama (in `cfg.provider`) stays eligible.
- `resolveVerify` (`cli/cmd/models.ts`): `providerID === "ollama"` → `{ ok: true }`
  (no auth, dynamic model set). `models --test` with NO provider filter SKIPS
  ollama (would probe 5 localhost models that may be down); `models --test ollama`
  still probes it.

Synthesized ollama models are `capabilities.toolcall = false` → they auto-enter
chat-only (Slice 3). Tests: `packages/opencode/test/provider/ollama.test.ts`.
Proven from source: `lmplayer models verify ollama/qwen2.5` → ok (also `:7b`,
`@host`); `lmplayer models ollama` lists the seeded set — all with no config.

## Slice 3 — conditional chat-only (omit tools for simple models)
`packages/opencode/src/session/llm/request.ts`, `prepare()`:
`const chatOnly = input.model.capabilities.toolcall === false; const tools =
chatOnly ? {} : resolveTools(input)`, and the OpenAI-strict + copilot `_noop`
fixups are wrapped in `if (!chatOnly)`. Result: a `tool_call:false` model is sent
NO tools → returns plain TEXT → can never emit malformed tool-call JSON. Capable
models (all github-copilot are `toolcall:true`) keep their FULL tool set
UNCHANGED. Final text reaches a control system via `--format json` as a `text`
event carrying `part.text` (run.ts:836). Wire-level test in
`test/session/llm.test.ts`: a `tool_call:false` model with a real tool in the
request still sends `body.tools === undefined`; `tool_call:true` control keeps
tools. Condition is general (any provider/model flagged `toolcall:false`), NOT
global.

## Slice 2 — verbose LLM file logging (debug qwen2.5 tool-call JSON)
Switch: env `LMPLAYER_LLM_VERBOSE=1` (or `true`) — RuntimeFlags `llmVerbose`
(`src/effect/runtime-flags.ts`), OFF by default. `Config.boolean` natively
accepts `1`/`true`/`yes`/`on`.
Sink: dedicated file `Global.Path.log/llm-verbose.log` =
`<XDG_DATA_HOME>/lmplayer/log/llm-verbose.log` (JSONL, one record per line).
Module `src/session/llm/verbose.ts`: `R = never` (plain `fs/promises.appendFile`
in `Effect.promise`, deliberately NOT the FileSystem service, so
`LLM.Service.stream`'s `Stream<LLMEvent, unknown>` R stays `never`); every write
`Effect.ignore`d (a logging failure never fails a turn); safe serializer
(Error/bigint/circular). Three flag-gated hooks in `session/llm.ts`:
`LLMVerbose.request(...)` before the runtime branch (messages, tool schemas,
params, headers, chatOnly); `includeRawChunks || flags.llmVerbose`; a
`Stream.tap` on the RAW ai-sdk `fullStream` before `toLLMEvents` (captures
tool-input deltas = raw tool-arg JSON, parsed tool-call, tool-error, error, raw
chunks). OFF is a true no-op (tap = `Effect.void` per event). Proven live against
real github-copilot: file got 2 `request` + 31 `event` records for one turn.
Tests: `test/effect/runtime-flags.test.ts` + two integration tests in
`test/session/llm.test.ts`.

## Regression guard (done before each push)
`bun typecheck` clean (+ full-monorepo typecheck via the pre-push hook, 30/30);
provider + llm + models + runtime-flags suites pass; the 4 github-copilot models
(claude-sonnet-5, claude-opus-4.8, gpt-5.5, gemini-2.5-pro) each return OK
(exit 0) via `lmplayer run --format json` from source. Additions are
additive/isolated.

## HANDOFF: BUILT-BUT-UNTESTED — for the local agent that HAS ollama
No ollama on the build host, so the live path was never round-tripped. Pull
lmplayer/dev, then:
1. `ollama serve` + `ollama pull qwen2.5`.
2. `lmplayer run --model ollama/qwen2.5 "hello"` — expect a plain TEXT reply
   (chat-only; no tools offered). Verify `--format json` yields a `text` part.
3. Try `@host`/`OLLAMA_HOST` for a remote box; try an arbitrary tag
   (`ollama/qwen2.5:7b`).
4. Turn on `LMPLAYER_LLM_VERBOSE=1`, run a turn, inspect
   `~/.local/share/lmplayer/log/llm-verbose.log` — confirm request/event records
   look right; if you WANT to see the malformed-tool-call failure, temporarily
   flip a model to `tool_call:true` (config) and watch where parsing breaks.
Likely live gaps to check: ollama's `/v1` streaming shape vs ai-sdk
openai-compatible expectations, and whether `includeUsage` (auto-set for
openai-compatible in resolveSDK) upsets ollama. Fix in provider.ts / request.ts
and report back.
