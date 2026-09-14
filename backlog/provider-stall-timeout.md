# PROVIDER-STALL-TIMEOUT

Status: resolved for the legacy AI SDK request path (2026-09-14).
Reporter: math meta-lead, 2026-09-14.
Tracker: lmbee epic #167, child task #168 (done); owner lmplayer2:Lead.
Evidence notes: #850 on task #168 and #851 on epic #167.

Observed across lmbi/localwebcli/creator: lmplayer run remains alive and idle
for over an hour, retaining the caller's servicing lock. Reported creator
snapshot: 4731 seconds elapsed, 82 seconds CPU, 485MB RSS, epoll_wait, no
children. External process state cannot identify the exact pending operation.

## Verified source findings

The legacy AI SDK OpenAI loader supplies a 300000ms header timeout. Its timer
is cleared when fetch resolves with headers. There is an existing SSE read
idle timeout (chunkTimeout), but OpenAI has no default for it. A total request
timeout (timeout) also exists only when configured. The wrapper explicitly
passes timeout:false to Bun fetch. Thus receipt of headers can leave the
response body unbounded under default options.

Codex OAuth forwards the request signal through its rewritten fetch request.
An OAuth refresh before transport, WebSocket behavior, post-provider tool work,
and CLI event-loop completion still need separate consideration. No claim that
the historical incident was definitively a stalled HTTP body.

## Narrow correction

OpenAI defaults now include chunkTimeout:300000 and timeout:1800000, retaining
the 300000ms header bound. Explicit configured values override defaults; total
and header timeouts retain their existing false opt-out. chunkTimeout accepts
a positive millisecond value. Non-OpenAI defaults are unchanged.

Idle error text now states the configured duration:
"Provider response read idle for <N>ms; aborting".
Existing real HTTP stalled-body tests exercise the read timeout. Tests also
check OpenAI defaults and explicit overrides. Before correction the default
and diagnostic assertions fail.

The total-ceiling regression, retry/error propagation, custom-fetch abort audit,
and installed CLI stall verification were completed; evidence follows below.


## Abort and retry audit

IdleTimeoutError retains the duration-bearing diagnostic and is terminal in
the session retry layer, avoiding five additional five-minute stalls. Other
transient stream failures retain existing retry behavior. Header timeouts
retain their prior retry policy. A custom-fetch cancellation guard bounds the
caller wait even if a plugin or authentication promise ignores the signal;
it does not claim to destroy resources privately owned by arbitrary plugins.

71 focused tests pass across provider timeout, cancellation, and retry tests.
Package typecheck and lint (zero errors) pass. Total timeout is independently
verified against an HTTP body whose idle bound is longer. A local stalled SSE
provider with a 100ms idle override produces a duration-bearing JSON error and
CLI exit 1. The isolated CLI smoke uses synthetic credentials and temporary
storage. The process completes rather than retaining its caller indefinitely.

Historical process snapshots do not prove the exact original stall location.
These changes bound the verified HTTP request gap; they are not a global
workflow deadline for tools, CPU stalls, or CLI operations outside provider IO.

Future substantive reports must be recorded in `lmbee tasks` before the turn
ends, with this repository record linked as supporting evidence. The standalone
`lmtasks` CLI uses a different ledger and is not this fleet tracker.
