# concierge/

The single entry point calling agents talk to.

```
MCP tools ask / get_component / get_foundation  →  Concierge
                     1. validate input
                     2. route to a specialist        (Phase 1: always components)
                     3. specialist drafts an answer from the contract
                     4. validate the draft against the contract
                     5. record the exchange in the audit log
                     6. return — or withhold the answer if step 4 failed
```

| File | Role |
|---|---|
| `concierge.ts` | Routing, validation gate, audit record. Runtime-agnostic. |
| `validate.ts` | Independent checks. `ask`: every component, part, prop, value, variant, import path, rule and related id exists in the contract. Fetches: every file is recorded in the contract, re-hashed to match the snapshot, and within the request's scope (recomputed from the request, not the response); packages and versions match. |
| `mcp.ts` | MCP server exposing read-only `ask`, `get_component` and `get_foundation` tools. Transport-agnostic. |
| `node.ts` | Node adapters: loads `contracts/<client>/contract.json` and the hash-verified `sources.json`, appends to `logs/<client>/requests.jsonl`. A Workers deployment swaps these for KV/R2/D1 equivalents. |

The concierge never reads the client repo, only the ingested contract. One server instance serves exactly one client, and its audit log refuses entries for any other client.

## `ask` statuses

| Status | Meaning for the calling agent |
|---|---|
| `answered` | `components` holds validated contracts. `unresolved` lists anything named in the question that does not exist. |
| `clarification-needed` | The question named no component. Ask again with `component` set to one of `clarification.options`. |
| `not-found` | The component does not exist in this design system. Do not build it; `alternatives` lists indexed options. |
| `error` | Invalid input, or the draft failed validation and was withheld. Details in `validation`. |

Schemas: `schema/response.ts` (JSON Schema: `schema/response.schema.json`).

## `get_component` / `get_foundation` statuses

| Status | Meaning for the calling agent |
|---|---|
| `delivered` | Write `files` exactly as delivered, install `packages`, follow `instructions`. `unresolved` / `rejected` list anything that was not delivered. |
| `not-found` | None of the requested components exist in this design system. |
| `rejected` | The requested components exist in source but are not in the client's inventory. |
| `error` | Invalid input, no source snapshot loaded, or the delivery failed validation and was withheld. |

The audit log records delivered file paths and hashes, not their contents.
