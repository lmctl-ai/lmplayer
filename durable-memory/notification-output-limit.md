# NOTIFICATION-OUTPUT-LIMIT: Codex notification request normalization

Reported by lmbi Lead on 2026-09-11. Notification-origin turns failed with
`Unsupported parameter: max_output_tokens` for `openai/gpt-6-astra`.

## Root cause

`session/llm/request.ts` supplied a default output-token cap. Ordinary turns
passed through the Codex plugin's `chat.params` hook, which removed it;
notification-origin turns deliberately skipped that hook. The AI SDK serialized
the remaining value as `max_output_tokens`, which the Codex backend rejected.
The OAuth fetch layer rewrites the destination without removing that body field.

The installed binary matched the previous build, and current source still had
the issue. Sanitized log inspection confirmed the reported error timestamps.
An isolated request-preparation reproduction using the real Codex hook showed
ordinary cap omitted versus notification cap 32,000 before the fix.

## Fix and scope

Final prepared parameters now omit `maxOutputTokens` when the provider is
`openai` and authentication is OAuth. This runs after optional hooks so a hook
cannot reintroduce the unsupported field. OpenAI API-key requests and other
providers retain their existing behavior. Notification turns still skip
unrelated system, parameter, and header plugin hooks.

This is a Codex OAuth transport constraint, not a claim that the public OpenAI
Responses API rejects output limits. No provider/model alias or config change
is needed. No lmbi/lmctl-src files or existing session records were modified.

## Verification

- Isolated preparation after the fix omits the cap for both origins.
- A live notification-prepared request through the production Codex OAuth
  fetch layer and real OpenAI SDK returned `NOTIFICATION_CAP_OK`. The probe used
  current credentials without refreshing or persisting them and did not create
  a session record.
- Independent source review found no blockers.
- Regression tests: `packages/opencode/test/session/notification-output-limit.test.ts`.
- Hook-isolation coverage: `packages/opencode/test/plugin/trigger.test.ts`.
- Seven new boundary tests pass, including captured serialized bodies, explicit
  OpenAI API-key preservation, and non-OpenAI OAuth preservation. Combined with
  hook and Codex plugin tests: 36 pass. Broader LLM/prompt suites: 105 pass,
  one pre-existing skip, zero failures. Typecheck and lint (zero errors) pass.
- Native build and version smoke pass; installed binary matches the artifact:
  `0.0.0-dev-202609120004`. Restart running processes to load this version.

Issue: `backlog/notification-output-limit.md`.
