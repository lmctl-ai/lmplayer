# NOTIFICATION-OUTPUT-LIMIT

Status: resolved (2026-09-12).
Reporter: lmbi.lmctl:Lead (2026-09-11).

Notification-origin turns using `openai/gpt-6-astra` receive HTTP 400:
`Unsupported parameter: max_output_tokens`.

Initial source verification confirms that request preparation supplies a default
output limit but skips `chat.params` on notification turns. The Codex plugin
normally clears that limit in the skipped hook.

Scope: normalize Codex OAuth requests without enabling unrelated notification
plugin hooks. Test serialized ordinary/notification requests and preserve limits
for unaffected providers. Do not change lmbi, lmctl-src, or application data.

Fix: normalize final OpenAI OAuth prepared parameters to omit output-token
limits, independently of hooks. Other providers/authentication paths retain
their caps. No unrelated hooks were re-enabled.

Verified: regression fails on old behavior and passes with the fix; 36 focused
tests pass; broader LLM/prompt suites have 105 pass, one existing skip, zero
failures; package typecheck and lint (zero errors) pass. Live notification-prepared
Codex request returns `NOTIFICATION_CAP_OK`. Built and installed
`0.0.0-dev-202609120004`; restart existing processes to load the fix.

Details: `durable-memory/notification-output-limit.md`.
