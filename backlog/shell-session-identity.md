# SHELL-SESSION-IDENTITY

Status: investigating.
Reporter: hermes Lead, relayed by lmctl-src Lead (2026-09-13).

Reported impact: a shell command from hermes printed another team's
LMCTL_SELF_SESSIONID; two subsequent coordination dispatches were attributed to
that team. Explicitly pinning the variable per command masks the symptom.
Reported session IDs are retained in the originating report, not needed here.

## Source findings

Current legacy ShellTool does not pool or persist a shell across calls.
`packages/opencode/src/tool/shell.ts` builds an environment from process.env
plus the shell.env hook, then spawns a fresh ChildProcess for each foreground
execution. Background submissions capture that environment and job-runtime.ts
spawns a separate process. The model-facing description in shell/prompt.ts
nevertheless says "persistent shell session"; that description is misleading.

The V2 bash tool also constructs a new ChildProcess per invocation via
AppProcess.run. Its default environment is inherited. The explicit session
shell path in session/prompt.ts inherits the server environment and overlays
shell.env plugin output as well.

There is no LMCTL_SELF_SESSIONID-specific handling in current packages source.
A shared/attached server started with one session's identity can therefore pass
that ambient value to a different session's child shell unless a plugin
corrects it. This is a plausible mechanism, not yet an incident reproduction.
The report's pooling explanation is not supported by the inspected code.

## Next verification

Obtain affected binary version, launch mode (standalone versus attached/shared
server), and exact functions.bash schema/runtime provenance from the reporter.
Requested through the current conversation. Do not collect credentials or
conversation bodies. Reproduce with synthetic identities in isolated processes:
two tool contexts under one host environment, foreground and background calls,
and explicit shell.env overrides. Compare with separate standalone processes.

Choose session-bound identity propagation only after checking the intended
lmctl identity contract for resumed and child sessions. Cover legacy, V2,
background jobs, and explicit session-shell paths as applicable. Do not mutate
the host process environment or existing session data. Preserve unrelated
changes and do not modify lmctl-src or hermes repositories.

No runtime fix or live reproduction claimed yet. Installed release remains
0.0.0-dev-202609120004; source baseline is 0f96964257.
