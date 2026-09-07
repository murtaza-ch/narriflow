# 04 — Make timeline field updates revision-safe

**What to build:** Apply boundary and transcript changes as typed mutations against the latest canonical document, so older field-specific screens cannot overwrite Studio work and every timeline change receives the correct render, preview, analysis, score, and cleanup treatment.

**Blocked by:** 01 — Establish the canonical persistence tracer through cloud save.

**Status:** done

**Specification:** [Deepen Clip Editor Document persistence](../spec.md)

- [x] Boundary and transcript field updates call the public persistence module and no longer own revision or invalidation rules in Clip Service.
- [x] Because the existing field PATCH contract has no base revision, each intent applies to the latest canonical document through bounded transactional retries rather than replacing a stale whole-document snapshot.
- [x] Exhausted concurrent contention returns a typed retryable outcome and leaves the user's attempted values available in the calling UI.
- [x] Boundary normalization preserves the existing sentence-aware timing behavior and rejects minimum-duration, maximum-duration, reversed, negative, and known-source overflow cases.
- [x] A boundary mutation after source removal is rejected before the current preview reference is cleared.
- [x] Transcript changes are canonicalized to the accepted stored window and cannot move clip boundaries through overlapping word timing.
- [x] A deletion or timing result that leaves no frame-safe content is rejected before commit.
- [x] A semantic no-op leaves the revision, original, mutable renders, preview, evidence, scores, and cleanup obligations unchanged.
- [x] The first real timeline mutation captures the pre-change canonical original if no earlier document mutation has done so.
- [x] Every real boundary or transcript mutation retires mutable current renders and records their cleanup obligations.
- [x] A boundary change retires the old preview proxy and peaks, invalidates incompatible Automatic, explicit Split, and Screen evidence, and recomputes duration-dependent scores.
- [x] A transcript-only change retains the source window, preview proxy, eligible composition evidence, and duration-dependent scores.
- [x] The existing PATCH payloads and successful response shapes remain stable; known validation, missing-resource, and retryable-concurrency outcomes receive consistent transport mappings.
- [x] Deterministic interface tests cover all timeline validation edges, no-ops, purged source, evidence retention and invalidation, and bounded retry behavior.
- [x] Isolated PostgreSQL tests race field intents with full replacement and prove that unrelated document fields cannot be lost or partially invalidated.
- [x] The edit-length and transcript-facing UX distinguishes validation from temporary conflict and does not clear typed input on retryable failure.
- [x] Focused service and web tests, the repository typecheck, and the repository test command pass.
