# logs/

Per-client audit trail, one folder per client:

```
logs/<client-id>/ingestion.jsonl   one entry per ingestion run: source commit, content hash, stats, changes
```

From Phase 1, request/response records from the concierge are written here too. Everything except this README is git-ignored.
