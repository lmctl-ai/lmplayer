# lmcode backlog

Persisted backlog of candidate work. lmcode's DEFAULT identity is a **coding tool** (enhanced opencode,
bash on); we dogfood it by using it to build real projects. Ordered by current thinking, not committed.

## Active
- **svg-transit (battle-test dogfood)** — build a generic SVG-domain visual transition engine with lmcode,
  as a hard greenfield project, to surface lmcode issues. Lives at `/niceapps/mma/oc/svg-transit`.
  Full design: `backlog/svg-transit.md`. This is the current priority (operator-directed battle test).

## Enhancements to lmcode itself (from the "what next" discussion)
1. **durable-memory on-demand write tool** — our flagship gap: `index.md` is only written by the organize
   compaction pass or session import; there is NO model/user-facing tool to read/write per-session
   durable-memory on demand. Add a first-class tool so a coding session curates its persistent memory
   continuously (not just at compaction). Self-contained, high leverage on our differentiator.
2. **lmcode installable binary** — today lmcode runs from source via `bun run .../index.ts`. Package it as
   a real installable CLI (`lmcode`) so it can be used day-to-day for coding outside the fleet harness.
   Enables real-world dogfood + distribution.
3. **dogfood-driven hardening** — keep running real coding tasks through the fleet; fix whatever pain
   surfaces (this loop already produced the `git workdir` fix + `wc` tool + the tokens/permission fixes).
   Empirical prioritization over guessing.
4. **model-specific prompt + tool profiles** — let a provider/model select a specialized system prompt and
   tool definition set instead of always receiving the generic coding-agent catalog. Immediate case:
   `ollama/qwen2.5+tools` should not receive read/write/git/gh/rg/etc. For qwen2.5, define one narrow
   lmctl-oriented tool (or one simple command wrapper) with a schema it can reliably call, so lmctl can run
   external shell commands on its behalf. This avoids granting or hiding broad permissions for unrelated
   tools and avoids relying on qwen to choose among the full lmplayer tool catalog.

## Umbrella / upstream
- **lmvideo** — LLM-first HTTP video service (storyboard-as-data → mp4 + timing report). Requirements +
  architecture in the `lmvideodev` chat room (idea/requirements + zero-browser pure-Rust rendering path).
  svg-transit is the separable, generic "transition between two SVG keyframes" component lmvideo needs.
  See `backlog/lmvideo.md` for the digest. Big, multi-part; not started — svg-transit is the first slice.

## Done (moved out of backlog, on dev)
- Observability suite (session report/health, compaction.mode, organize-vs-summary finding).
- Structured linux tools (mkdir/rm/mv/cp/touch/ls/find/git/gh/rg/tar/curl/wget/unzip/wc) + scoped workdir.
- File-based deterministic permissions (permission_ask fallback honored in V2 + migration).
- Config-free model+effort selection (verified; was inherited from opencode).
- lmctl token integration (V2 session token totals persisted) + contract doc.
- Built-in `secured` agent (opt-in, bash-free, non-interactive profile).
- durable-memory portal (non-compacting, on by default) — confirmed working.
