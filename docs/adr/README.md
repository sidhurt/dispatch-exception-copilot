# Architecture Decision Records

One file per decision: `NNN-short-title.md`. Siddharth writes them.

Each ADR answers four things in plain words:
1. **Context:** what problem forced a decision?
2. **Decision:** what did we choose?
3. **Why not the alternatives:** the 2–3 obvious other choices, and why we didn't take them.
4. **What it costs us:** what gets harder because of this choice.

## Proposed first five (titles only, not yet written)

| # | Title | Covers |
|---|---|---|
| 001 | The model proposes; code executes | Why the model never calls an ERP write, and what checks the executor runs |
| 002 | The mock ERP is a separate service, reached only over HTTP | Why not one app with one database; what the boundary teaches |
| 003 | OData V4-style API instead of SAP-style V2 | Why the cleaner convention; what we dropped (CSRF step, `/Date()/`) |
| 004 | A PGI that timed out is reconciled, not retried | Idempotency keys and checking before retrying (depends on your SPEC §8.2 answers) |
| 005 | One agent on the Anthropic SDK, no framework | Why no LangChain and no multi-agent setup; what we build ourselves |
