# Copilot model profiles (characterization, not load-balancing)

Purpose (operator): use varied models to LEARN what each can do + its limits. Update as evidence accrues.
All via `github-copilot/<id>`. Roster verified running here: claude-sonnet-4.6, gpt-5.3-codex, gemini-2.5-pro,
gpt-5.5. Also entitled: claude-opus-4.8(/-fast), claude-opus-4.7(/-fast), claude-sonnet-5, claude-haiku-4.5.
DISABLED: gpt-5.4.

## Observed so far (2026-07-05)
- **gpt-5.5** — reliable default. Ran team-leads + workers end-to-end (observability, tools, lmvideo e2e).
  No failures observed. Good all-rounder for orchestration + coding.
- **gpt-5.3-codex** — strong for deep code fixes. Succeeded on the lmcode toolfix batch (git/glob/exec) and on
  the svg-transit M2 worker AFTER claude failed. Good pick for gnarly multi-file code changes.
- **claude-sonnet-4.6** — capable, but hit a **32K output-token cap on a single step → worker aborted with 0
  commits** (svg-transit M2 attempt 1). Watch for large single-step outputs; prefer for well-scoped tasks or
  split the work. Otherwise strong reasoning.
- **gemini-2.5-pro** — ran the lmvideo lead fine. **Multimodal / VISION** — designated (operator) as the visual
  QA reviewer: sample rendered frames as PNG and have gemini assess quality (transitions look right? captions
  match? layout ok?). To be exercised as the fleet's visual-QA judge.

## Known issues to investigate
- **Requested model not always honored:** a worker seeded with `--model github-copilot/gpt-5.3-codex` reported
  it actually ran as gpt-5.5. Undermines per-role model assignment. Investigate lmcode model resolution /
  provider fallback; surface mismatch instead of silently substituting.

## Usage policy
- Assign per ROLE/TASK to learn + exploit strengths: codex for heavy code; claude for scoped reasoning (mind the
  output cap); gemini for vision/QA + breadth; gpt-5.5 as reliable default/orchestration.
- Record every model-specific success/failure/limit here as the fleet runs.
