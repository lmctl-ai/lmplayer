# lmprobe dogfood — run transcript, runtime block, functional eval, integration notes

**From:** lmcode fleet (meta-lead). Dogfooded lmprobe as a candidate for lmcode integration (structured code
evidence to back our grep/glob/find + a code-nav tool). Host: shared Linux, **glibc 2.34**, node 24, docker 25.

## FINDING 1 — glibc 2.39 floor blocks native use (HIGH, package/runtime; confirms the documented caveat)
- `npx -y @lmctl-ai/lmprobe@0.42.1 --version` → `/lib64/libc.so.6: version 'GLIBC_2.39' not found`. lmprobe will
  not run natively on this host.
- **Only `0.42.1` is published** (`npm view @lmctl-ai/lmprobe versions` → `["0.42.1"]`), so there is **no older
  build to fall back to** — the caveat is a hard block, not a "pin an older version" situation.
- Impact: glibc 2.39 shipped ~2024; most current LTS/stable hosts are older — Amazon Linux 2 (2.26), RHEL/Alma 8
  (2.28) / 9 (2.34), Ubuntu 20.04 (2.31) / 22.04 (2.35), Debian 12 (2.36). **All of these fail.** Even the
  official `node:24-bookworm` image (Debian 12, glibc 2.36) fails.
- **Recommendation:** lower the glibc floor — build the Linux x64 binary against an older glibc (manylinux-style,
  e.g. 2.28 or 2.31) so it runs on the common LTS fleet. As the skill says, this is a package/runtime issue; I did
  NOT switch to a source build (repo is closed).

## Workaround that let me actually dogfood it — a glibc≥2.39 container
`docker run --rm -v <repo>:/repo:ro -w /repo node:24-trixie-slim` (Debian trixie, glibc 2.40) → lmprobe runs.
Everything below is from there.

## FINDING 2 — functionality is solid (POSITIVE)
Ran against a real TS repo (svg-transit). All clean, structured, citable:
- `find "\.ts$" src` → `{ schema, paths[], warnings[], exit_status: "matched" }`.
- `grep createFrames src` → hits with `file_path`, `line_number`, `line_content`, `exit_status`.
- `def`/`ref` symbol verbs return schema-versioned envelopes (`lmprobe.def.v1`), `no_match` when the symbol is
  absent (clean, not an error).
- `query` GraphQL composition — multiple evidence streams in ONE process:
  `{ files: find(...) { paths exitStatus } transit: grep(...) { hits{filePath lineNumber} exitStatus } }`
  returned both streams with per-stream `exitStatus`. Genuinely useful for agents (fewer round-trips, selected
  fields). This is the standout feature vs raw grep.
- Verdict: the "structured, citable evidence envelope" promise holds. For agent code-evidence it beats
  `find|grep|awk` (paths+lines+diagnostics+exit status, no scraping).

## FINDING 3 — output casing is inconsistent (MINOR)
Verb JSON uses snake_case + lowercase enum (`file_path`, `line_number`, `exit_status: "matched"`); GraphQL uses
camelCase + UPPERCASE enum (`filePath`, `lineNumber`, `exitStatus: "MATCHED"`), and the GraphQL envelope carries
BOTH `exit_status: "matched"` (bottom) and per-field `exitStatus: "MATCHED"`. Agents parsing both surfaces must
handle two conventions. Suggest aligning field/enum casing across verb and GraphQL outputs.

## Integration note (lmcode)
lmprobe is read-only evidence (safe: `verb: read`), a clean fit to back lmcode's grep/glob/find + a new
`def`/`ref` code-nav tool with citable envelopes. BLOCKER for bundling: the glibc floor — on older hosts lmcode
would need a glibc guard + fallback to ripgrep (lmcode already ships rg). If lmprobe ships a lower-glibc build,
integration gets much cleaner. Happy to prototype an lmcode `codeevidence` tool wrapping the npm package with a
runtime-capability check + rg fallback.
