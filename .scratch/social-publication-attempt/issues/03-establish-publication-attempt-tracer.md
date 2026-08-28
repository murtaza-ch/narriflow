# 03 — Establish the durable Social Publication Attempt tracer

**What to build:** Publish and settle one due frozen Social Post through the approved Social Publication Attempt interface with durable attempt lineage, immutable claim fencing, provider checkpoints, explicit uncertainty, and atomic receipt plus analytics settlement.

**Blocked by:** [01 — Prefactor providers behind one publication seam](01-prefactor-publication-platform-seam.md); [02 — Freeze an idempotent publication intent](02-freeze-idempotent-publication-intent.md).

**Status:** done

**Specification:** [Deepen the Social Publication Attempt](../spec.md)

## Observable acceptance criteria

- [x] Add Social Post, Social Publication Attempt, Publication Claim, Provider Receipt, and Frozen Publication State to the domain glossary and record ownership in an ADR.
- [x] A Social Publication Attempt stores immutable Social Post and frozen-input lineage, attempt number, prior-attempt link, lifecycle phase, normalized outcome, provider evidence, and terminal facts.
- [x] Claiming one due Social Post creates or resumes one attempt with an immutable claim ID and lease; every checkpoint and settlement compares both attempt and claim identity.
- [x] The public attempt module accepts only an owned attempt and abort signal and owns media access, credentials, provider sequencing, checkpoints, normalized outcome, settlement, analytics intent, diagnostics, and cleanup.
- [x] The worker caller claims due work and invokes only the attempt interface. It does not choose a provider phase, retry, reconciliation, settlement, or cleanup sequence.
- [x] A durable checkpoint is written before provider submission starts. Bearer-like checkpoint state is encrypted and absent from ordinary reads and diagnostics.
- [x] Accepted provider evidence creates one Provider Receipt and atomically marks the attempt succeeded, projects the Social Post Posted, and records analytics intent.
- [x] A lost response after terminal settlement replays the existing result without another provider call or analytics event.
- [x] A definitive failure before possible provider acceptance projects Failed with a stable code and safe-retry disposition.
- [x] A timeout or interruption after submission may have started projects Needs attention unless the adapter already returned an exact pending operation for later recovery.
- [x] Posted can never move back to Failed because analytics, logging, metrics, cleanup, or response delivery fails after settlement.
- [x] A stale claim cannot checkpoint, fail, or complete after another claim owns the attempt.
- [x] Cancellation and claim race atomically: cancellation wins before submission, or the owned attempt proceeds and cancellation reports that publishing has started.
- [x] All six platform adapters enter through this attempt path in the direct cutover; the former status-only completion, failure, reaper, and worker orchestration are removed.
- [x] The shared service package re-exports the new module without exporting internal adapter protocols to ordinary callers.

## Public-interface and failure-injection tests

- [x] Behavior tests call only the approved attempt interface and assert returned outcome, durable attempt, claim, Social Post, receipt, analytics intent, and diagnostics.
- [x] The deterministic platform adapter proves accepted with and without URL, definitive failure, pending checkpoint, unknown outcome, abort, and conflicting receipt.
- [x] Failure injection before and after claim, frozen-state load, credentials, media access, checkpoint, submission, provider response, receipt write, post projection, analytics intent, claim release, and cleanup leaves one truthful outcome.
- [x] Disposable PostgreSQL tests prove claim uniqueness, stale fencing, atomic accepted settlement, rollback, receipt uniqueness, cancellation race, and idempotent replay.
- [x] Tests reproduce the current analytics-after-success failure and prove the new transaction leaves the post Posted.
- [x] Worker tests prove ownership loss is control flow and cannot be translated into provider failure.

## Migration and direct cutover constraints

- [x] Apply attempt, receipt, claim, state, and index migrations before enabling the new worker code.
- [x] Drain social-publishing workers before cutover and restart only the new attempt path; old and new protocols never claim live work together.
- [x] Reset or explicitly surface unsupported local `publishing` fixtures rather than inventing a legacy attempt parser.
- [x] Rollback drains the social worker first and preserves durable attempt and receipt evidence.

## Scope boundaries

- [x] Implement one ordinary accepted tracer plus safe definitive and unknown outcomes; deep pending reconciliation, heartbeats, fairness, and automatic retry arrive in ticket 04.
- [x] Do not deepen provider-specific recovery beyond evidence already exposed by its adapter.

## Fresh-task handoff

Implement after tickets 01 and 02 with `/implement`; drive the approved interface and database fencing with `/tdd`; finish with `/code-review`; run uncached attempt, publisher, worker, database, migration, typecheck, lint, test, and build checks.
