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
