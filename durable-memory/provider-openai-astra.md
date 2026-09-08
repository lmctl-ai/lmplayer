# GPT-6 Astra resolution (2026-09-08)

Reported by math.lmctl while dogfooding `egtry-books/diagram.lmctl` with
`provider=lmplayer` and `provider=opencode`, both `model="openai/gpt-6-astra"`.

## Finding

`openai/gpt-6-astra` is the correct model string and works with the existing
OpenAI/Codex OAuth credentials. Do not infer provider unavailability from its
absence in an old OpenCode model listing. Current models.dev includes Astra
under OpenAI and GitHub Copilot; account access is a separate question.

Official references:

- https://developers.openai.com/api/docs/models/gpt-6-astra
- https://developers.openai.com/api/docs/guides/latest-model

Tool calling uses Responses. Keep the native OpenAI provider/SDK; do not replace
it with an OpenAI-compatible Chat Completions provider or alias another model.

## Root cause and fix

`packages/opencode/src/plugin/openai/codex.ts` filters OAuth models against an
allowlist and a fallback regex requiring a dotted numeric version. The new
undotted `gpt-6-astra` name failed both checks. Add that exact API model ID to
the allowlist; retain existing pro-mode exclusions and zero OAuth cost handling.
Regression coverage is in `test/plugin/codex.test.ts`.

Explicit `provider.openai.models` declarations are merged after the plugin
filter, providing a workaround for older installed OpenCode binaries. Added the
verified declaration to `~/.config/opencode/opencode.json` (backup saved before
editing), canonical `lmctl-src/examples/opencode.json`, and its website mirror.
Published the single example object at https://lmctl.com/examples/opencode.json.
The example uses a conservative 272,000-token context matching this host's
Codex model cache; the public API catalog advertises 1,050,000. It declares
reasoning, tool calls, text/image input, and low/medium/high/xhigh/max variants.
It contains no credentials and does not change the user's default model.

The rebuilt lmplayer resolves Astra without a custom model declaration using
the current catalog. Existing authentication is still required. Local lmplayer
and OpenCode have separate XDG auth/config directories.

## Verification

- Declared model: installed lmplayer returned `ASTRA_OK`; installed OpenCode
  1.18.27 returned `ASTRA_OPENCODE_OK`, both exit 0.
- Config-free fixed source: Astra called `bash` with `pwd`, received `/tmp`,
  and completed a second provider turn with `ASTRA_TOOL_OK`.
- Installed rebuilt lmplayer: medium-effort request returned
  `ASTRA_INSTALLED_OK`, exit 0.
- `lmctl lint /home/mma/repos/egtry-books/diagram.lmctl`: `ok`, exit 0.
- 25 Codex plugin tests passed; package typecheck passed; lint had zero errors;
  native build and example config validation passed; independent review found
  no blockers.
- Authenticated Copilot `/models` returned HTTP 403 for this host, so Copilot
  entitlement was not established. No Copilot declaration was added.

Coordination attempts to math Lead and lmctl-src Lead returned busy, not queued;
never treat those attempts as delivered messages. Final findings must be sent
through the originating reply or retried when the receiver is available.
