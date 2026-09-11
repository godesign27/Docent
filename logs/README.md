# logs/

Per-client audit trail, one folder per client:

```
logs/<client-id>/ingestion.jsonl   one entry per ingestion run: source commit, content hash, stats, changes
logs/<client-id>/requests.jsonl    one entry per concierge request: who asked, what was asked, routing signals and scores,
                                   what was returned, validation checks, flags, latency, contract hash
logs/<client-id>/reviews.jsonl     escalated requests awaiting a human, as append-only created/decided events
```

A request is `flagged` when its answer failed validation, the input was invalid, it was rejected or escalated by governance, it drew a governance warning, it asked for something that does not exist, it touched a component outside the inventory, or a component's spec has drifted from source.

Everything except this README is git-ignored.
