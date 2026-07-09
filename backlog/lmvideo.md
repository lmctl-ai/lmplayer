# lmvideo (umbrella) — digest

Source: `lmvideodev` chat room (idea/requirements + architecture addendum, from the wfm81/agent-pref team).
Not started as a whole; **svg-transit** (see svg-transit.md) is its separable first slice and our battle test.

## What lmvideo is
LLM-first HTTP video service (same ethos as lmsound/lmchat: plain HTTP, one opaque key, stateless).
An agent writes a **storyboard as data**; the service does capture + SVG/vector compositing + transitions
+ TTS + sync + captions + encoding → returns an **mp4 + a machine-checkable timing/sync report**
(review the storyboard + report, not the pixels).

## Capabilities requested
- Screenshot capture (Playwright: URL / CSS selector, live product).
- Declarative diagram drawing (nodes/edges/labels → vector slide).
- **SVG-native slides + vector transitions between SVG slides** ← svg-transit is exactly this piece.
- Narration + auto-sync (delegate TTS to lmsound; align by measured duration_ms; captions from same text).
- Per-scene voice selection; captions bound to visual/evidence (drift check).
- One storyboard → multiple cuts (`include_scenes` / `target_seconds`).

## API sketch
`POST /render` with `{ size, fps, scenes:[{ id, visual:{screenshot|svg|diagram}, narration:{text,voice_id,engine},
captions, transition_in, duration:"auto" }] }` → presigned mp4 URL + timing report. Also `/voices`,
`GET /render/{id}`, `GET /render`.

## Architecture note (from addendum)
- Prior art: **hyperframes** (HTML→video via headless Chrome, agent-first) and **video-use** (post-editor).
- Recommended trajectory: prototype fast (browser-backed), but architect the **renderer as a swappable
  backend** and grow a **zero-browser pure-Rust** renderer (html5ever + lightningcss + taffy + rquickjs/v8
  + skia-safe + ffmpeg-next) as the flagship single-binary path. Constrain the authored HTML/CSS/animation
  subset so the native renderer only supports what lmvideo emits.

## Our angle
svg-transit is the highest-value, most separable, most testable slice AND a great lmcode battle test.
Build it generic (not lmvideo-specific); lmvideo consumes it as one component.

## NEXT PHASE (operator 2026-07-07): Flash-style video-scripting DSL + lmsound in same DSL
- After the 2 main features ship (DSL->SVG+PNG; slides->video single-step, no exposed frame/svg->png steps):
- Extend to a VIDEO DSL: move / rotate / any TRANSFORM of a shape or shapes; select colors to TWEEN — on a
  timeline. Study OLD FLASH / ActionScript-era timeline scripting (and similar video scripting languages) to
  model the DSL on.
- INTEGRATE lmsound into the SAME DSL: one DSL drives both video and audio (narration/sound cues on the timeline).
