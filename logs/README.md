# logs/

Per-client audit trail, one folder per client:

```
logs/<client-id>/ingestion.jsonl   one entry per ingestion run: source commit, content hash, stats, changes
logs/<client-id>/requests.jsonl    one entry per concierge request: who asked, what was asked, routing,
                                   what was returned, validation checks, flags, latency, contract hash
```

A request is `flagged` when its answer failed validation, the input was invalid, it asked for a component that does not exist, it touched a component outside the inventory, or the component's spec has drifted from source.

Everything except this README is git-ignored.
