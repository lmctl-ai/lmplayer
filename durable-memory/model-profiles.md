# Copilot model note (corrected)

CORRECTION (operator, 2026-07-05): **gpt-5.5 is the only real model on this copilot account** and it is the
most capable — no issue. The other entitled names (claude-*, gemini-2.5-pro, gpt-5.3-codex) effectively resolve
to / fall back to gpt-5.5, which is why a worker "requested codex but ran as gpt-5.5". That is EXPECTED, not a
bug. So:

- **Do NOT spend effort "balancing" models.** Use `github-copilot/gpt-5.5` for leads and workers.
- The earlier "model not honored" finding is WITHDRAWN (there is one model behind the names).
- The "claude 32K output cap" failure was a single-step output-size issue on gpt-5.5-behind-a-name, not a
  distinct model's limit; treat as: very large single-step outputs can hit a cap → keep worker tasks scoped.
- **Visual QA:** use gpt-5.5's own multimodal capability to review sampled PNG frames (no separate vision model
  needed). If gpt-5.5 cannot accept image input in a given path, fall back to describing/ættributing frames.

Net: one capable model (gpt-5.5). Simplify. No per-role model assignment.
