# Copilot models — empirical finding (config-free, and they are REAL distinct models)

## The question
Can we use `github-copilot/claude-*` (and gemini/codex) WITHOUT config (unlike opencode which needs the model
declared in opencode.json first)? And are they real, or do they all fall back to gpt-5.5?

## Empirical test (2026-07-05, config-free, no opencode.json edits)
Ran `run --model github-copilot/<id> "state exactly which model+maker you are"` for each. Results:
- `gpt-5.5` → "GPT-5.5, built by OpenAI"
- `claude-sonnet-4.6` → "Claude Sonnet 4.6, built by Anthropic"
- `claude-opus-4.8` → "Claude Opus 4.8, Claude family, Anthropic (via GitHub Copilot)"
- `gemini-2.5-pro` → "Gemini family, built by Google"
- `gpt-5.3-codex` → "GPT-5.3 Codex, OpenAI"

## Conclusion (supersedes the earlier "gpt-5.5 is the only model" note)
- **YES — config-free model use works.** `--model github-copilot/<id>` resolves from the models.dev catalog for
  any authenticated provider; NO opencode.json declaration needed (this is the lmcode-vs-opencode win we filed to
  lmctldev, and it is accurate).
- **They are DISTINCT, REAL models**, not gpt-5.5 wearing name tags: each correctly self-IDs its family + maker
  (Anthropic / Google / OpenAI), including specific version numbers. Very unlikely for one model masquerading.
  (Caveat: self-identification is strong but not absolute proof; behavior + the earlier claude-specific 32K
  output cap also point to genuinely different backends.)
- **Re the earlier "worker requested codex but ran as gpt-5.5":** most likely the LEAD's spawn command did not
  actually pass `--model` for that nested worker, so it used the default (gpt-5.5) — an orchestration bug, NOT
  evidence that all names collapse to gpt-5.5. When `--model` is passed, the requested model is served (verified
  above).

## So
Claude/Gemini/Codex ARE usable here, config-free. If the operator's account is intended to expose only gpt-5.5
(billing/policy), that is not what the runtime shows today — flagging the discrepancy openly. Practically: we CAN
use per-role models (e.g. claude for reasoning, codex for code) config-free; just ensure the spawn actually
passes --model.

# PROFILES — positive tool provisioning + lean system prompt (SHIPPED, branch `lean-profiles`)

Commit `6a2f51d2d`, pushed to lmplayer (Coder=sonnet-5, Reviewer1=gpt-5.5 adversarial → APPROVE-WITH-NITS,
signed off). PR: https://github.com/lmctl-ai/lmplayer/pull/new/lean-profiles

## The principle (operator): INVERT materialize-all-then-deny
Today the runtime builds the FULL ~28-tool catalog then subtractively denies via permissions
(`registry.tools()` → `Permission.disabled`, then `resolveTools()` at request.ts:214), and picks a big
provider prompt file by model family (`system.ts:26 provider()` → anthropic/gpt/default.txt, 8–11K chars).
A **profile** flips this to POSITIVE provisioning: declare exactly the tools to provide; build/send only those.
"Put one dish on the table; don't show all the food then say eat one." Validated need: qwen2.5 botches the full
generic tool catalog (wrong arg keys/types; describes calls instead of emitting) but shells out via `bash` to
lmctl/git/curl fine → weak models need a lean, model-specific prompt + narrow tool set.

## Config shape
A profile = an AGENT carrying: `prompt` (lean system prompt — already REPLACES the provider .txt at
`request.ts:60`) + NEW `provision: string[]` (positive tool allowlist). Fields:
- Runtime `Agent.Info` (`packages/opencode/src/agent/agent.ts:55`): `provision: Schema.optional(Schema.Array(Schema.String))`.
- Config `ConfigAgentV1.Info` (`packages/core/src/v1/config/agent.ts`): `provision: Schema.optional(Schema.mutable(Schema.Array(Schema.String)))` + KNOWN_KEYS (user-configurable profiles; NOT collapsed into permission — it is NOT the deprecated boolean `tools` deny-map).
- Threaded config→runtime at `agent.ts:387` `item.provision = value.provision ?? item.provision`.

## Positive provisioning vs the old deny model (WHY it's different, not just `{"*":deny, x:allow}`)
- `registry.tools()` (`registry.ts:350`): when `input.agent.provision` is set, `filtered = registered.filter(t =>
  provisionSet.has(t.id) || t.id === InvalidTool.id)` and the subtractive `disabled` computation is BYPASSED.
  So only the allowlist's model-facing DEFINITIONS are built (JSON schema + plugin hooks) — independent of the
  permission ruleset. Under an ALLOW-ALL permission the deny model would send the whole catalog; provisioning
  still sends only the listed tools. (Scope note: the built-in Tool objects still `Tool.init` once at layer init,
  agent-independent — provisioning governs which DEFINITIONS are built/sent, not process-level instantiation.)
- `resolveTools()` (`request.ts:220`) is the final gate: under a profile, keep `k === InvalidTool.id ||
  (provision.has(k) && !disabled.has(k))` — drops MCP/extra tools too. Non-provisioned path preserved
  byte-for-byte (`return !disabled.has(k)`), so `build`/secured/explore are UNCHANGED (additive).
- Two INFRA sentinels are exempt (never OFFERED — `activeTools` excludes `invalid` at `llm.ts:338`): `invalid`
  (malformed-tool-call repair target, always retained under a profile so weak models degrade gracefully) and the
  Copilot `_noop` replay shim (`request.ts:165` now guarded by `provision === undefined` — never injected for a
  profile). Net wire (`body.tools`) = exactly the profile's list.

## The lean qwen2.5 profile (SHIPPED)
Built-in `lean` agent (`--agent lean`, `mode:"primary" native:true`), added next to `secured` in `agent.ts`:
- prompt = `src/session/prompt/lean.txt` (783 chars, "monitor + delegate via lmctl") vs default.txt 8528 → ~91% smaller.
- `permission: {"*":"deny", bash:"allow"}` (deny-all also suppresses the skills/MCP prompt blocks via system.ts gates).
- `provision: ["bash"]` → bash is the ONLY tool sent. Chose bash-only (proven reliable shell-out) over a narrow
  structured lmctl tool (would reintroduce the malformed-arg failure qwen has). bash is a broad/high-trust tool.

## Proof (tests) + reduction
- `test/tool/registry.test.ts`: under ALLOW-ALL permission + `provision:["bash"]`, `registry.tools()` →
  `ids.filter(id=>id!=="invalid")` EQUALS `["bash"]` (exact-set; the catalog read/edit/write/grep/… all absent).
- `test/session/llm.test.ts`: capable model (`tool_call:true`) + allow-all + `provision:["bash"]` + a multi-tool
  input → outgoing `body.tools` EQUALS `["bash"]` and system text contains the lean prompt sentinel.
- Reduction: ~28 model-facing tool defs → 1; base prompt ~91% smaller. typecheck (opencode+core) clean;
  `bun test test/tool/registry.test.ts test/session/llm.test.ts test/agent/agent.test.ts` = 97 pass / 0 fail.

## Decisions / follow-ups (flagged)
- SELECTION = PER-AGENT (`--agent lean`) for this slice (reviewer agreed). Per-model auto-select (qwen* → lean)
  and config-defined user profiles are wired through the schema but left as follow-ups.
- ACTIVE PATH ONLY: legacy `packages/opencode` (run → client.session.prompt → server handlers/session.ts:61 →
  SessionPrompt.Service). V2 `packages/core` is NOT on the active path; its analogous choke point
  `ToolRegistry.materialize()` (`core/src/tool/registry.ts:106`) + `runner/llm.ts:203` is the documented follow-up.
