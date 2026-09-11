# concierge/

The MCP entry point and routing agent. **Starts in Phase 1** (see `docs/IMPLEMENTATION_PLAN.md`).

It will read only from `contracts/<client-id>/contract.json` via the schema in `schema/contract.ts`, and never from the client repo directly.
