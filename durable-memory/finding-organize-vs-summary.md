# Organize vs Summary Fixture

- Measurement basis: `Token.estimate(JSON.stringify({ messages, durableMemory }))` after compaction filtering.
- Organize: 3862 -> 482 tokens, 87.5% reduction, needle retained: yes.
- Summary: 3862 -> 420 tokens, 89.1% reduction, needle retained: no.
