# Design proposal: trusted-execution policy (the blocker to retiring bash)

Status: PROPOSAL for operator decision. Drafted by meta-lead from the QA bash-free validation evidence
(durable-memory/finding-bash-free-validation.md). The *decision* is the operator's; this lays out options.

## Problem (empirically confirmed)
We replaced raw bash with 16 structured tools (linux/* + read/write/edit). A worker with bash DISABLED
successfully wrote code, searched, and used git — but could NOT:
- run verification: `bun test <path>`, `bun typecheck`
- install dependencies: `bun install`
because there is no structured tool for them, and raw bash is off. So a fully bash-free agent cannot verify
its own work. This is the single remaining blocker to retiring bash.

## Why these are different from the safe CLIs we already wrapped
rg / tar / curl / wget / unzip / find / ls / git have BOUNDED behavior: we parse argv, apply a hard
deny-list, and `classify()` the call. `bun` / `npm` / `pnpm` / `yarn` / `docker` are different in kind:
they execute ARBITRARY repo-authored code. A test file, a build script, a `postinstall` hook, or a
Dockerfile can run anything. No argv deny-list can constrain what `bun test` actually does, because the
danger is in the code it runs, not the flags. This is a real trust boundary, not a parsing problem.

## Options
- **A. Don't wrap them; profile split.** Keep raw bash ONLY in an explicit engineer/"trusted-dev" agent
  profile. Secured / end-user agents never execute repo code at all (they edit + hand off to a trusted
  runner). Simplest; matches "engineer-authored policy, end-user-invisible". Cost: secured agents can't
  self-verify — a trusted step (human or trusted agent) runs tests.
- **B. Declared-command runner tool.** A single structured `script`/`run-task` tool that executes ONLY
  operator-DECLARED commands from a config allowlist (e.g. `test: "bun test"`, `typecheck: "bun typecheck"`)
  in an allowed package dir — no arbitrary argv. Still runs repo code, but only through named entrypoints
  the engineer sanctioned. Gives self-verification back without a generic shell.
- **C. Sandboxed execution.** Run the code-executing tool inside a container/sandbox with constrained
  filesystem + network (deny by default). This is the *real* trusted-execution boundary for genuinely
  untrusted code. Heavier to build; strongest guarantee.
- **D. classify()+policy grant.** Mark these tools `dangerous:true, resource:"exec"`; default-deny; require
  an explicit engineer policy grant scoped to a package dir (and, later, a sandbox). Integrates with the
  existing semantic-permission model (lmprobe evaluates classify() output against policy).

## Recommendation
Combine **B + D now**, design toward **C**:
1. Add a declared-command runner (B) — unblocks self-verification via `bun test <path>` / `bun typecheck`
   only, from an allowed package dir. No arbitrary commands.
2. Wire it through classify() as `dangerous:true, resource:"exec", scope:<package-dir>`, default-deny,
   engineer-granted (D). Unknown/undeclared command => deny.
3. Keep raw bash exclusively in an explicit trusted-dev profile until (C) exists.
4. Treat broader package managers (`npm/pnpm/yarn`) and `docker` as still-deferred until a sandbox (C) is
   designed; installing deps that run `postinstall` is untrusted-code execution and should be sandboxed.

## The decision I need from the operator
1. Stance: A, B+D, or hold for C? (My rec: B+D now, C later.)
2. Trust boundary: do we ever execute untrusted repo code locally (accepting the risk for a dev tool), or
   ONLY inside a sandbox? This determines whether `bun install`/`postinstall` is allowed pre-sandbox.
3. Scope granularity for the exec grant: per-package-dir is my default; confirm or refine.

Everything is captured so once you pick a stance I can seed a team-lead to implement it.
