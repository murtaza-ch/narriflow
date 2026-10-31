# 04 - Transactional dispatch and wake delivery

**What to build:** Transactional dispatch and wake delivery.

**Blocked by:** 03

**Status:** claimed

**Spec:** [Serverless cutover](../spec.md)

- **Build:** §4.1: outbox append/claim/ack/retry, immediate after-commit dispatcher, retryable acceptance, Workflow event delivery, hourly safety reconciler.
- **Files:** `packages/services/src/execution-dispatch{,-runtime}.ts`, producers, `apps/api/src/execution/**`, `apps/api/src/workflows/maintenance.ts`.
- **Accept:** crashes after commit, after create, or before ack lose nothing and duplicate nothing. Existing instances reconcile. Unregistered dispatches stay visible and retryable. No minute scan.

## Evidence

Transactional dispatch core is implemented and verified. Full ticket acceptance remains blocked on the integrated Workers runtime and all producer/wake wiring.

- `appendExecutionDispatch(tx,input)` appends in the caller's transaction, replays one deterministic delivery identity, and rejects changed immutable inputs/due time. Input hash is excluded from identity so mismatches cannot silently create another instance.
- Instance IDs remain stable across registration, child wakes and observed-deadline deliveries. Keys and instance IDs are 67 characters.
- `createExecutionDispatch({database,scheduler})` exposes exact-id delivery, receipt-preserving acceptance confirmation, read and bounded hourly reconciliation. The injectable scheduler port distinguishes confirmed registration from confirmed notification; an existing Workflow never acknowledges a wake.
- Claims and settlement take epoch shared lock, exact row lock and DB time. No SQL transaction survives the scheduler call. Stale/expired delivery tokens and superseded epochs cannot acknowledge.
- Initial `nextDeliveryAt` is DB now, even for a future operation dueAt. Active claims move it to lease expiry. Recovery binds one observed DB timestamp so the epoch/pending/due partial index can bound the scan. No polling loop is installed.
- Failures store identifier-only bounded codes and bounded retry/dead-letter facts; delivery retries do not admit domain attempts.

Verification, 2026-10-31:

- `bun test packages/services/src/execution-dispatch.test.ts`: 3 passed, 14 assertions.
- `ALLOW_SERVERLESS_DB_TESTS=1 bun --env-file=/tmp/narriflow-serverless-gates/database.env test packages/services/src/execution-dispatch.db.test.ts`: 12 passed, 44 assertions. Strict host guard restricted the run to the isolated serverless gate branch; every fixture used unique IDs and cleanup. Raw evidence is `/tmp/narriflow-serverless-gates/dispatch-tests-final.log`.
- DB cases cover concurrent append/conflict, rollback, future-due registration, lost scheduler response, lost DB response after acknowledgement commit, live-owner race/no retained transaction, stale token, expiry, wake confirmation, wrong epoch, dead letters and bounded/empty recovery.
- `bun run --cwd packages/services typecheck`: passed. Biome check of the core/runtime/tests and services manifest: passed.

Still required: atomically connect every producer and child result/deadline wake, immediate HTTP acceptance adapters, Workflow/DO/Modal scheduler implementation, event destination delivery and real deployed crash/replay gates. Root owns producer integration while ticket 05 establishes transaction-aware domain commands.
