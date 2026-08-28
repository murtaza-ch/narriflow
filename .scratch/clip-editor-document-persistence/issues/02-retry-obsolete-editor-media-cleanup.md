# 02 — Retry obsolete editor media cleanup

**What to build:** Delete media made obsolete by accepted Clip Editor Document mutations through a bounded worker protocol that survives storage errors and worker crashes without delaying or reversing the user's edit.

**Blocked by:** 01 — Establish the canonical persistence tracer through cloud save.

**Status:** ready-for-agent

**Specification:** [Deepen Clip Editor Document persistence](../spec.md)

- [ ] The worker claims due cleanup obligations in bounded batches with an immutable claim identity and an expiring lease.
- [ ] Only the current claim can renew, reschedule, or complete an obligation; late settlement from an expired claimant changes nothing.
- [ ] An expired claim becomes available to another worker without manual repair.
- [ ] Cleanup deletes only the exact recorded object and never derives or broadens a prefix at execution time.
- [ ] Provider not-found is an idempotent success, including when the same cleanup is delivered more than once.
- [ ] Temporary provider failures retry with jittered exponential backoff capped by validated worker configuration.
- [ ] Configuration and persistent provider failures remain due and visible after reaching the delay cap rather than being discarded.
- [ ] Successful or failed cleanup cannot change the Clip Editor Document, editor revision, current render membership, or user-facing mutation result.
- [ ] Structured diagnostics identify the project, clip, cleanup class, attempt, phase, typed outcome, and elapsed time without logging document content, URLs, storage keys, or provider bodies.
- [ ] A diagnostics failure cannot change cleanup settlement.
- [ ] The worker poll loop starts, stops, and respects cancellation without holding an abandoned claim indefinitely.
- [ ] Existing orphan reconciliation remains available for pre-reference upload crashes and does not become a second owner of document-mutation cleanup obligations.
- [ ] Deterministic interface tests cover success, not-found, temporary failure, delay capping, stale claim settlement, expired-claim recovery, duplicate delivery, cancellation, and diagnostics failure.
- [ ] Isolated PostgreSQL tests prove durable process-boundary recovery and fenced cleanup settlement.
- [ ] Worker tests, focused service tests, the repository typecheck, and the repository test command pass.
