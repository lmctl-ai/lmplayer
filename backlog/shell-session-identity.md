# SHELL-SESSION-IDENTITY

Status: resolved (2026-09-13).
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

## Confirmed reproduction and targeted correction (2026-09-13)

Reporter confirmed version 0.0.0-dev-202609120004 and the exact legacy bash
schema, including background and job tools. API-host-managed launch mode is
known; standalone versus shared server remains unknown.

An isolated test process started with LMCTL_SELF_SESSIONID=ses_wrong_host
executed two concurrent real shell calls with distinct synthetic session IDs.
Before the correction both returned ses_wrong_host. After the correction each
returns its calling context's session ID; the host environment is unchanged.
This reproduces a concrete inheritance failure without asserting the exact
incident launch topology. The correction assigns LMCTL_SELF_SESSIONID after
ambient and plugin environment merging. Background jobs receive the same
session-bound environment snapshot. The persistence claim in the description
is corrected to describe fresh processes.

All 27 shell tests pass, including two new identity regressions. Lint reports
zero errors (10 existing warnings). Native build version smoke passes for
0.0.0-dev-202609130354. A test-fixture type error was corrected during validation.

Remaining: independently verify the installed runtime path and cover V2 and
explicit session-shell identity propagation before closing the broader issue.


## Remaining entry points corrected

V2 bash and the explicit session-shell API independently reproduced the same
wrong-host identity failure before correction. Both now overlay the calling
session ID on the child environment without mutating the host. Real-process
regressions pass: 11 V2 bash tests and 11 session-shell tests (other prompt tests
were filtered out). Both package typechecks pass; lint has zero errors.

A rebuilt binary (0.0.0-dev-202609130410) serving isolated temporary storage
passed two concurrent HTTP session-shell requests under a synthetic wrong host
identity. Both returned their own session IDs. No existing session data or
credentials were used. The temporary server was terminated after verification.

Final installation: 0.0.0-dev-202609130410 installed and byte-compared with the
built artifact. The same isolated concurrent HTTP identity probe passed using
/home/mma/.local/bin/lmplayer. All probe processes exited. Fix commits:
50f40e82ba and fd9c74fc98, pushed to origin/dev. Restart long-running hosts to
load the correction; command-level manual overrides remain possible by design.
