# 05 — Make publication webhooks idempotent and reconcilable

**What to build:** Replace the legacy bare-2xx publication webhook with a signed, idempotent receipt contract that can report accepted, pending, definitive failure, or unknown and can reconcile the same external operation.

**Blocked by:** [04 — Recover claims and bound publication retries](04-recover-claims-and-bound-retries.md).

**Status:** done

**Specification:** [Deepen the Social Publication Attempt](../spec.md)

## Observable acceptance criteria

- [x] Every webhook request carries the stable Social Publication Attempt idempotency key, Social Post identity, platform, frozen content facts, and signature.
- [x] The payload contains only intended publication content and scoped media access; it excludes credentials, private storage identity, and internal provider state.
- [x] An accepted response includes a durable receiver receipt and optional external post ID, URL, or metrics.
- [x] A pending response includes a durable receipt, bounded next-check guidance, and an authenticated reconciliation contract.
- [x] A definitive failure includes a stable receiver code and safe-retry or permanent disposition.
- [x] A bare 2xx, invalid body, lost response, or conflicting receipt becomes Unknown and follows reconciliation or Needs attention policy; it is never guessed as Posted.
- [x] Replaying the same attempt key returns or recovers the same receiver operation and cannot create a second publication.
- [x] Duplicate accepted responses and metrics settle idempotently without duplicate analytics.
- [x] Receiver rate limits and temporary failures preserve `Retry-After` and retry only when no submission may have been accepted.
- [x] The old response parser and unsigned compatibility behavior are removed in the same cutover.
- [x] Configuration validates webhook URL, signing secret, request deadline, response size, allowed redirect policy, and reconciliation bounds at startup.
- [x] Publish and Calendar display pending, reconciling, accepted, definitive failure, and unknown receiver outcomes through the shared status model.

## Adapter contract and failure-injection tests

- [x] Contract tests cover signature construction, content type, stable attempt key, duplicate request, accepted receipt, pending reconciliation, definitive failure, and accepted metrics.
- [x] Tests cover timeout before connection, connection loss after body send, malformed success, oversized response, redirect, authentication failure, rate limit, server failure, and conflicting receipt.
- [x] A receiver harness proves one external operation under concurrent duplicate requests and lost responses.
- [x] Failure injection before and after send, response receipt, checkpoint persistence, reconciliation, and settlement produces no untracked duplicate.
- [x] Secret-exclusion tests inspect logs, diagnostics, analytics, snapshots, and operator output.

## Migration and cutover constraints

- [x] Document the new receiver request, response, idempotency, signature, timeout, and reconciliation contract without real secrets.
- [x] Cut over directly under the pre-production policy. Do not retain the legacy bare-2xx success contract.
- [x] Reset local receiver fixtures that cannot satisfy the new contract.

## Scope boundaries

- [x] Do not turn the webhook into a general event bus or add arbitrary callback scripting.
- [x] Do not add native providers or accept an unverified asynchronous callback as a receipt.

## Fresh-task handoff

Implement after ticket 04 with `/implement`; use `/tdd` for the receiver contract and every lost-response window; finish with `/code-review`; run uncached webhook, attempt, worker, security-redaction, typecheck, lint, test, and build checks.
