# Mock ERP

The system of record the copilot works against. It's built from [`docs/SPEC.md`](../../docs/SPEC.md) §3–6.

## Run it

```bash
npm install          # once, from the repo root
npm run erp          # starts on http://localhost:4001 with the standard Kestrel Cement data
```

No Docker needed. The database is [PGlite](https://pglite.dev), a real Postgres that runs inside the Node process. Its data lives in memory, so every restart begins again from `fixtures/base.json`.

**After a database change** (a new file in `drizzle/`), stop the ERP and start it again. `npm run erp` restarts itself on code changes, but not when a new migration appears, so it can end up with an out-of-date database (you'll see 500 errors).

## Try it

```bash
curl "http://localhost:4001/odata/Customers?\$select=customerId,name,creditStatus"
curl "http://localhost:4001/odata/Trucks('TRK-011')?\$expand=carrier"
```

## Where things are

| File | What's in it |
|---|---|
| `src/db/schema.ts` | the tables (SPEC §3) |
| `src/domain/` | the business rules: statuses and guards (SPEC §4) |
| `src/odata/actions.ts` | the five write actions and the fixed order of checks (SPEC §5.4, §5.7) |
| `src/odata/routes.ts`, `query.ts` | reads: `$filter`, `$select`, `$expand`, keys, navigation (SPEC §5.1) |
| `src/chaos.ts` | timeout-after-commit, lock conflict, outage (SPEC §6) |
| `src/sim/` | `/sim`: reset and fixtures, plus the "pretend this happened" endpoints (SPEC §5.5) |
| `fixtures/base.json` | the standard starting data |
| `test/erp.test.ts` | 30 tests that drive the ERP over real HTTP |

## Tests

```bash
npm test -w services/mock-erp
```
