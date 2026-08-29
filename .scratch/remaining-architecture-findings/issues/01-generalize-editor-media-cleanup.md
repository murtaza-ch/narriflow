# 01 — Generalize Editor Media Cleanup into Media Cleanup

**What to build:** Replace the editor-only deferred deletion path with one Media Cleanup module that can durably own exact-key object removal for every approved producer. Existing Clip Editor Document Persistence cleanup must keep working through the generalized interface, with the same fencing, retry, idempotency, and diagnostic guarantees.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

**Specification:** [Close the remaining architecture findings](../spec.md)

- [ ] A generic Media Cleanup obligation records stable origin and cleanup class, project and Clip identifiers where applicable, the private exact object key, attempt and scheduling state, claim identity and expiry, bounded failure state, completion, and timestamps.
- [ ] Cleanup obligations do not require the source Clip row to survive and cannot disappear through a Clip cascade.
- [ ] One Media Cleanup interface owns claim, renewal, completion, rescheduling, release, storage-error classification, bounded backoff, and identifier-safe diagnostics.
- [ ] Missing objects settle as successful cleanup; temporary failures retry; configuration, persistent, cancelled, and claim-loss outcomes remain explicit and fenced.
- [ ] Obligation admission is idempotent and cannot create competing active work for the same cleanup meaning and exact object key.
- [ ] Clip Editor Document Persistence creates generalized obligations atomically with accepted mutations that retire mutable renders, preview proxies, or preview peaks.
- [ ] The worker polls only the generalized Media Cleanup module and preserves the current bounded shutdown, claim, and retry behavior.
- [ ] Diagnostics contain stable origin, class, project, Clip, attempt, phase, outcome, failure code, and elapsed time without object keys, signed URLs, provider identifiers, provider bodies, or document content.
- [ ] The editor-specific schema, worker, exported names, configuration names, and duplicate implementation are removed in the same cutover; no dual reader, writer, poller, fallback, or compatibility selector remains.
- [ ] The relevant ADR and domain language distinguish Media Cleanup execution ownership from Clip Editor Document Persistence ownership of when editor mutations create cleanup intent.
- [ ] Deterministic interface tests cover claim fencing, expiry, renewal, missing-object success, temporary retry, bounded backoff, cancellation, persistent/configuration failures, settlement claim loss, and diagnostic redaction.
- [ ] Isolated PostgreSQL tests prove obligation uniqueness, concurrent claims, stale settlement rejection, survival without a Clip row, and atomic creation with an accepted document mutation.
- [ ] Existing Clip Editor Document mutation, cleanup, worker, typecheck, lint, and fast aggregate tests pass after the direct replacement.

