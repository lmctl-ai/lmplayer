# PROVIDER-STALL-TIMEOUT

Status: investigating; OpenAI default bounds correction in progress.
Reporter: math meta-lead, 2026-09-14.

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

Remaining: total-ceiling regression, retry/error propagation and custom-fetch
abort audit, then build/install and installed CLI stall verification. Do not
close based solely on configuration assertions or a version smoke test.
