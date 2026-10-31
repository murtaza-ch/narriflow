# 04 - Transactional dispatch and wake delivery

**What to build:** Transactional dispatch and wake delivery.

**Blocked by:** 03

**Status:** ready-for-agent

**Spec:** [Serverless cutover](../spec.md)

- **Build:** §4.1: outbox append/claim/ack/retry, immediate after-commit dispatcher, retryable acceptance, Workflow event delivery, hourly safety reconciler.
- **Files:** `packages/services/src/execution-dispatch{,-runtime}.ts`, producers, `apps/api/src/execution/**`, `apps/api/src/workflows/maintenance.ts`.
- **Accept:** crashes after commit, after create, or before ack lose nothing and duplicate nothing. Existing instances reconcile. Unregistered dispatches stay visible and retryable. No minute scan.

## Evidence

Pending implementation and verification.
