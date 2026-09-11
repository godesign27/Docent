# concierge/

The single entry point calling agents talk to.

```
MCP tool ask  →  Concierge.ask()
   1. validate input
   2. extract mentions (components, tokens, patterns, rules, governed entities)
   3. route: score each specialist on evidence; clarify when nothing is clear
   4. each routed specialist drafts a section from the contract; sections are merged
   5. governance outcome: disallowed → rejected, needs-review → escalated (answers withheld, review opened)
   6. validate the merged response against the contract and the escalation policy
   7. record the exchange (with routing signals and scores) in the audit log
   8. return — or withhold everything if step 6 failed
```

| File | Role |
|---|---|
| `router.ts` | Evidence-based routing with recorded signals and scores. |
| `concierge.ts` | Merging, governance outcome, review creation, validation gate, audit record. Runtime-agnostic. |
| `eval.ts` | Runs a labelled batch of requests and compares routing and outcomes. |
| `validate.ts` | Independent checks. `ask`: every component, part, prop, value, variant, import path, rule and related id exists in the contract. Fetches: every file is recorded in the contract, re-hashed to match the snapshot, and within the request's scope (recomputed from the request, not the response); packages and versions match. |
| `mcp.ts` | MCP server exposing read-only `ask`, `get_component` and `get_foundation` tools. Transport-agnostic. |
| `node.ts` | Node adapters: loads `contracts/<client>/contract.json` and the hash-verified `sources.json`, appends to `logs/<client>/requests.jsonl`, keeps reviews as an append-only event log in `logs/<client>/reviews.jsonl`. A Workers deployment swaps these for KV/R2/D1 equivalents. |

The concierge never reads the client repo, only the ingested contract. One server instance serves exactly one client, and its audit log refuses entries for any other client.

## `ask` statuses

| Status | Meaning for the calling agent |
|---|---|
| `answered` | `components` holds validated contracts. `unresolved` lists anything named in the question that does not exist. |
| `clarification-needed` | Nothing in the question settled what it is about. Ask again naming one of `clarification.options`, or set `domain`. |
| `not-found` | What was asked for does not exist in this design system. Do not build it; `alternatives` lists indexed options. |
| `rejected` | The rules disallow it (`governance.findings` cites them). Do not proceed. |
| `escalated` | A human must decide first. Nothing was answered; poll `check_review` with `review.id`. |
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
