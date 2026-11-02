# ZAI Coding Plan — lmplayer setup + raw API reference

Verified live 2026-11-02 with the operator's key against the production endpoints.
The coding plan is Z.ai's flat-rate GLM subscription — a different product from
pay-per-token `zai` (api.z.ai/api/paas/v4), though both accept the same key.

## Part 1 — lmplayer setup

The catalog provider id is `zai-coding-plan`. **The env var the catalog checks is
`ZHIPU_API_KEY`, NOT `ZAI_API_KEY`** — the operator's key is stored in `ZAI_API_KEY`,
so either alias it or configure explicitly:

- Zero-config (verified working): `ZHIPU_API_KEY="$ZAI_API_KEY" lmplayer run --model zai-coding-plan/glm-5.3 ...`
- Permanent: add to `~/.config/lmplayer/opencode.jsonc`:

```jsonc
"provider": {
  "zai-coding-plan": {
    "options": { "apiKey": "{env:ZAI_API_KEY}" }
  }
}
```

In an lmctl teamfile: `model="zai-coding-plan/glm-5.3"`.

**Model lineup changes — check before choosing.** As of 2026-11-02 the coding plan
serves `glm-5.3`, `glm-5.3-flash`, `glm-5.3-highspeed` (plus `glm-5.2` variants).
`glm-4.7` is NOT on the coding plan (it is on pay-per-token `zai`): asking for it
fails with `ProviderModelNotFoundError … Did you mean: glm-5.3, glm-5.3-flash,
glm-5.3-highspeed?` — the suggestion list in that error is the current lineup.
`lmplayer models zai-coding-plan` lists what the catalog believes.

Verified round trip: `run --model zai-coding-plan/glm-5.3 --format json` → clean
NDJSON (`step_start`/`text`/`step_finish`), token accounting present, ~4s first
token.

## Part 2 — raw API for writing an agent from scratch

### Endpoints (both verified 2026-11-02 with the coding-plan key)

| API style | Base URL | Auth header | Use |
|---|---|---|---|
| OpenAI-compatible | `https://api.z.ai/api/coding/paas/v4` | `Authorization: Bearer $KEY` | chat completions, streaming, tool calling |
| Anthropic-compatible | `https://api.z.ai/api/anthropic` | `x-api-key: $KEY` + `anthropic-version: 2023-06-01` | Claude-Code-style agents |

### OpenAI-compatible message format

POST `{base}/chat/completions`. Request is standard OpenAI:
`{"model": "...", "messages": [...], "max_tokens": N, "stream": bool, "tools": [...], "tool_choice": "auto"}`.

**Reasoning-model quirk (GLM-5.x):** the reply carries reasoning in a SEPARATE
`reasoning_content` field, and final answer text in `content`:

```json
{"choices": [{"finish_reason": "stop", "message": {
  "role": "assistant",
  "reasoning_content": "The user is asking me to ...",
  "content": "pong"}}],
 "usage": {"prompt_tokens": 17, "completion_tokens": 16,
           "completion_tokens_details": {"reasoning_tokens": 16}, "total_tokens": 33}}
```

Consequences for an agent loop:
- Read `message.content` for the answer; `reasoning_content` is chain-of-thought
  (display/debug only, do NOT feed it back as message history).
- `max_tokens` is consumed by reasoning FIRST — a small cap yields
  `finish_reason: "length"` with empty `content` (observed). Budget generously.
- Streaming is standard SSE: `data: {"object":"chat.completion.chunk",
  "choices":[{"delta":{"reasoning_content":"..."}}]}` chunks, then content deltas,
  ending with `data: [DONE]`.

**Tool calling — standard OpenAI shape** (verified live):

```json
"tools": [{"type": "function", "function": {
  "name": "get_weather",
  "description": "Get current weather for a city",
  "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}]
```

Response: `finish_reason: "tool_calls"` and

```json
"message": {"content": "", "reasoning_content": "...",
  "tool_calls": [{"id": "call_-7120599823039854638", "index": 0, "type": "function",
                  "function": {"name": "get_weather", "arguments": "{\"city\":\"Paris\"}"}}]}
```

Agent loop: execute the call, append the assistant message (with `tool_calls`)
then a `{"role": "tool", "tool_call_id": "<id>", "content": "<result>"}` message,
and re-POST. `function.arguments` is a STRINGIFIED JSON object — parse it, and
tolerate malformed JSON from weaker models.

### Anthropic-compatible message format

POST `https://api.z.ai/api/anthropic/v1/messages` with `x-api-key` +
`anthropic-version: 2023-06-01`. Request/response are the Anthropic Messages
shape; reasoning arrives as `{"type": "thinking", "thinking": "...", "signature": "..."}`
content blocks (verified), so multi-turn agents must pass thinking blocks back
unchanged per Anthropic's rules. This is the endpoint Claude Code points at via
`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`.

## Errors worth handling

- Model not on the plan: HTTP 200 path never happens — lmplayer surfaces
  `ProviderModelNotFoundError` from the catalog; the raw API returns a 4xx with a
  JSON error body. Treat "model not found" as a config error, not a retryable one.
- The key is shared between `zai` (pay-per-token) and `zai-coding-plan` (subscription)
  — same credential, different base URL and billing. Don't mix the bases.
