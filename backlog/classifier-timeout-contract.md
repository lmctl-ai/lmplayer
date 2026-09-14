# Classifier timeout follow-up

Task175, epic167. Installed lmplayer 0.0.0-dev-202609141141 was byte-compared
with its build artifact. Task168 note850 records installed CLI stalled-response
exit1 with duration diagnostic; the earlier commit's Not-tested trailer was
superseded by that subsequent verification, not silently reinterpreted.

Lmplayer's provider.options timeout/headerTimeout/chunkTimeout are transport
configuration overrides consumed during SDK construction. They are not per-turn
prompt fields; model providerOptions do not configure that wrapper. Callers
using the internal LLM interface can pass an abort signal; CLI callers need
isolated config or their own supervision deadline. No new CLI flag is claimed.

Miniplayer currently uses AI SDK generateText directly (src/providers.js:170-175),
with AbortSignal.timeout resolved per generateOneShot invocation. Its config
requestTimeoutMs defaults to60000; MINIPLAYER_REQUEST_TIMEOUT_MS overrides it
(src/config.js:19-26). Passing config:{...config,requestTimeoutMs:10000} with no
environment override provides a short per-invocation total bound. A process-local
environment override is available to CLI callers. Never mutate global process.env
per concurrent request. Each failover candidate gets its own budget, so the caller
must also bound the overall classification/tick budget.

Coordination sent to miniplayer: verify installed parity, actual Ollama/deepseek
failover and SDK retry/overall-budget behavior. No miniplayer code or config
modified. Shared-DB design clarified to require owner-exported DDL/version and
exactly one composed migration runner; see docs/design/opencode-shared-store.md.
