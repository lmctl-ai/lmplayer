lmctl token health contract

Primary source: read the SQLite `session` table from `~/.local/share/lmcode/opencode.db`, which is `Global.Path.data/opencode.db`. The database uses WAL mode; open it read-only and let SQLite read the WAL/shm sidecars normally.

Key rows by `session.id`. The cumulative per-session context/token columns are:

- `tokens_input`
- `tokens_output`
- `tokens_reasoning`
- `tokens_cache_read`
- `tokens_cache_write`

Example:

```sql
SELECT tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write
FROM session
WHERE id = ?;
```

Alternative source: call `GET /session/:sessionID` and read `.tokens` from the returned session info.

Tiny example result:

```json
{
  "id": "ses_123",
  "tokens": {
    "input": 1200,
    "output": 340,
    "reasoning": 0,
    "cache": { "read": 800, "write": 50 }
  }
}
```
