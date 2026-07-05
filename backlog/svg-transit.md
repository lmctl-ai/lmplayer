# svg-transit — generic SVG-domain visual transition engine

Battle-test dogfood project: build this HARD greenfield tool WITH lmcode to stress-test lmcode and
surface issues. Captures the operator's design discussion (2026-07-05).

## What it is (one line)
`SVG keyframe A + SVG keyframe B + duration + optional hints → intermediate SVG (or PNG) frames`
— the *motion* between two static SVGs. A **generic visual transition compiler**, not tied to any
producer's semantics.

## The core value = separation of concerns
- Upstream producers (diagramkit / hand SVG / browser-screenshot SVG / any generator) make **static SVG
  keyframes**. Semantics live THERE, before rendering — they are not in the SVG.
- svg-transit consumes only the **SVG visual structure** of any two frames and produces the transition.
- Because it depends on SVG geometry/structure (not the original semantic model), it works for ANY two
  SVGs. That genericity is the product. The client only decides: the two frames, how long, and some hints.

## NOT this
- NOT a generic text/XML diff. It is an **SVG-domain** correspondence engine.
- NOT coupled to diagramkit. Do not require diagramkit classes/metadata (use them as *hints* only if present).

## The hard part: correspondence (the creative core)
Given old elements and new elements, decide the mapping:
- old A → new B (matched: moved / resized / restyled / text-changed)
- old A → disappeared (exit)
- new B → appeared (enter)
- old A → B + C (split, one-to-many)
- old A + B → C (merge, many-to-one)

### Matching score (SVG-domain similarity)
- same `id` — strongest
- same semantic role/`class` — strong
- same text/label content — strong
- same shape type (rect/circle/line/path/text/…) — medium
- similar size (bbox w/h) — medium
- nearby position (bbox x/y) — medium
- same parent/group — medium
- same stroke/fill/style — weak
- optional `data-*` hints (`data-id`, `data-kind`, `data-role`) — strong when present (but never required)

### Transition policy (maps confidence → animation)
- high-confidence match → **morph / move** (interpolate position, size, style, path)
- low-confidence match → **fade out + fade in** (crossfade)
- one-to-many → **split** animation
- many-to-one → **merge** animation
- unmatched old → **exit** (fade/shrink)
- unmatched new → **enter** (fade/grow)
- text changed on a kept box → keep box, **crossfade the text**
- edge/path retarget → **bend/retarget** OR fade old + draw new
The creativity is in this **policy layer**, not the math.

## Pipeline
1. Parse SVG → normalized visual objects.
2. Flatten groups/transforms into **canonical absolute geometry** (resolve nested transforms → abs x/y/w/h).
3. Extract candidates: `rect, circle, ellipse, line, polyline, polygon, path, text, image, group`.
4. Match old/new by the SVG-domain similarity score above.
5. Classify each: same, moved, resized, restyled, text-changed, entered, exited, split, merged.
6. Generate intermediate SVGs by interpolating attributes over t∈[0,1] with easing.

## Hints (all optional; sensible defaults without them)
```yaml
duration: 1.2s
easing: ease-in-out          # linear | ease-in | ease-out | ease-in-out
prefer:
  - match: "#a -> #b"        # force a correspondence
  - morph: ".old-node -> .new-node"
fallback:
  unmatched: fade
  textChange: crossfade
  pathChange: redraw
```

## Suggested stack + shape
- **TypeScript** (pairs with diagramkit's isomorphic TS SVG; excellent XML/SVG tooling; easy to test).
- Library + thin CLI: `svg-transit A.svg B.svg --frames 30 --duration 1.2 --easing ease-in-out -o out/`
  → writes `out/frame_0000.svg … frame_0029.svg` (PNG/mp4 encoding is a later, separate concern).
- Pure functions where possible; deterministic output (same inputs → identical frames) for snapshot tests.

## Milestone 1 (MVP — the battle-test scope)
- Parse two SVGs; extract `rect, circle, ellipse, line, text` with absolute geometry (flatten transforms).
- Match by: explicit `id` → `class` → (shape-type + nearest position). 
- Classify: matched(move/resize/restyle), entered, exited (defer split/merge/path-morph).
- Interpolate to N frames; support `linear` and `ease-in-out`.
- Deterministic; snapshot-tested with hand-made fixtures:
  - circle moves left→right (matched move), 
  - a box appears (enter/fade-grow),
  - a box disappears (exit/fade-shrink),
  - a box changes fill (restyle),
  - text label changes (crossfade).
- CLI emits intermediate SVG frames.

## Later milestones (backlog within the project)
- path morphing (same-command-count fast path; resampling otherwise)
- split (1→many) / merge (many→1) animations
- edge/arrow retargeting
- PNG/mp4 frame encoding
- richer easing + per-element hint overrides

## Dogfood objective (why we're building it)
Primary output is svg-transit itself; EQUALLY important is a running catalog of any **lmcode** issues,
friction, or gaps hit while building a real hard project (this is the battle test). Record them.
