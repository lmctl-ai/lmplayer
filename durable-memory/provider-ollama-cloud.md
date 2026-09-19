# Ollama Cloud — model specification in lmplayer

Companion to provider-ollama.md (which covers LOCAL ollama). This doc covers
Ollama Cloud (`ollama.com` hosted models) — the models.dev catalog provider
`ollama-cloud`, authenticated with `OLLAMA_API_KEY` (points at ollama.com).
Do NOT confuse the two: `ollama/<model>` = local daemon (custom seeded provider,
no key, default `http://localhost:11434`); `ollama-cloud/<model>` = hosted API.

## Auth

- Set `OLLAMA_API_KEY` in the environment (the operator's shell already has it).
- Never commit or print the key value.

## How to specify a model

Model IDs are `<name>` or `<name>:<tag>` exactly as listed by
`curl https://ollama.com/api/tags` (no `library/` prefix). In lmplayer:

```bash
lmplayer run --model ollama-cloud/<name> "prompt"
lmplayer run --model ollama-cloud/<name>:<tag> --format json -- "prompt"
lmplayer models ollama-cloud        # list catalog models
```

In an lmctl teamfile member line: `model="ollama-cloud/<name>"`.

## Available models (fetched 2026-09-18 from https://ollama.com/api/tags)

### deepseek
- `deepseek-v4.1-flash` (487 GB, updated 2026-09-10) — newest deepseek on cloud
- `deepseek-v4-pro:0813` (893 GB, 2026-08-13)
- `deepseek-v4-flash:0731` (167 GB, 2026-07-31)

### kimi (Moonshot)
- `kimi-k3` (1.56 TB, 2026-07-27) — largest kimi
- `kimi-k2.7-code` (595 GB, 2026-06-12) — code-specialized
- `kimi-k2.6` (595 GB, 2026-04-20)

### qwen (Alibaba)
- `qwen3.5:397b` (397 GB, 2026-02-16) — only qwen currently on cloud

### others (for completeness)
- `glm-5.3` (755 GB), `glm-5.3-flash` (328 GB), `glm-5.2`, `glm-5.1` (1.5 TB)
- `minimax-m3`, `minimax-m2.7` (481 GB)
- `nemotron-3-ultra`, `nemotron-3-super` (230 GB), `nemotron-3-nano:30b` (33 GB)
- `gpt-oss:120b` (65 GB), `gpt-oss:20b` (14 GB) — smallest/cheapest cloud options
- `gemma4:31b` (63 GB), `mistral-large-3:675b` (682 GB)

The catalog changes; refresh with `curl -s https://ollama.com/api/tags`.

## Notes / open questions

- Tool calling over ollama cloud: unverified — Coder's ollama-cloud task
  (in flight 2026-09-18) includes a live tool-call check; update this doc with
  the result. Local-ollama experience (provider-ollama.md) showed weak models
  need the `lean` profile (bash-only provisioning); expect the same for the
  smaller cloud models.
- `capabilities.toolcall` comes from the models.dev catalog entry — if a model
  is wrongly flagged `toolcall:false` it silently goes chat-only (request.ts
  `prepare()`); check the catalog entry before assuming tools work.
