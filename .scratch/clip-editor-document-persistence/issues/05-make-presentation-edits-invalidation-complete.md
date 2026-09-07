# 05 — Make presentation edits invalidation-complete

**What to build:** Persist caption, B-roll, and Studio edits through canonical latest-document mutation, so real presentation changes always retire stale renders while no-ops and unrelated preview or analysis state remain untouched.

**Blocked by:** 01 — Establish the canonical persistence tracer through cloud save.

**Status:** done

**Specification:** [Deepen Clip Editor Document persistence](../spec.md)

- [x] Caption preset, B-roll, and Studio edit field updates call Clip Editor Document Persistence and no longer implement their own revision or cleanup behavior.
- [x] Existing field PATCH payloads apply typed intent to the latest canonical document through bounded transactional retries.
- [x] Caption null and omitted stored values resolve through the current canonical default rather than creating a second document shape.
- [x] B-roll and any currently policy-governed external media values pass the same safety validation regardless of mutation entry point.
- [x] Studio edits pass strict schema validation and preserve every unrelated Studio edit field.
- [x] Canonically equivalent caption, B-roll, and Studio edits are zero-write no-ops.
- [x] The first real presentation mutation captures the pre-change canonical original if it has not already been captured.
- [x] Every real presentation mutation increments the revision once, marks the clip edited, retires mutable current renders, and records deduplicated cleanup obligations.
- [x] Presentation mutations retain the preview proxy, waveform peaks, duration-dependent scores, and composition evidence when the source window and deleted ranges are unchanged.
- [x] A race with a full-document save either applies the field intent to the newer document or returns a typed retryable outcome; it never restores unrelated stale values.
- [x] Existing successful route responses remain stable, and known unsafe-media, malformed-document, missing-resource, and contention outcomes map consistently.
- [x] Deterministic interface tests cover each intent, defaults, deep-equivalent no-ops, retained derived state, render invalidation, original capture, validation, and injected failures.
- [x] Isolated PostgreSQL tests prove revision behavior, atomic render invalidation and cleanup insertion, and preservation of unrelated fields under races.
- [x] The caption edit and other affected controls preserve attempted input and show retryable failures without claiming success.
- [x] Focused service and web tests, the repository typecheck, and the repository test command pass.
