# 03 — Reset the complete document through persistence

**What to build:** Make Reset to original restore one canonical Clip Editor Document through the same revision, validation, invalidation, transaction, and cleanup rules as cloud save, so Reset cannot preserve stale output or race another writer.

**Blocked by:** 01 — Establish the canonical persistence tracer through cloud save.

**Status:** ready-for-agent

**Specification:** [Deepen Clip Editor Document persistence](../spec.md)

- [ ] Reset is a typed single-document mutation handled by Clip Editor Document Persistence rather than a separate persistence implementation.
- [ ] Reset restores the complete immutable original, including boundaries, transcript, caption preset, Studio edits, B-roll, and deleted ranges.
- [ ] A clip with no preserved original returns a revision-guarded no-op without creating one or changing dependent state.
- [ ] A repeated Reset after the original already matches the current canonical document is a true zero-write no-op.
- [ ] A stale Reset returns the current revision and never applies the original over newer work.
- [ ] The stored original remains immutable before, during, and after Reset.
- [ ] Reset validates the restored document against current duration, renderability, source availability, and external-media safety policy before commit.
- [ ] A boundary-changing Reset invalidates the preview proxy and peaks, relevant Automatic, explicit Split, and Screen evidence, duration-dependent scores, and mutable renders.
- [ ] A Reset that keeps the source window and deleted ranges retains eligible preview and composition evidence while still retiring mutable renders for changed output.
- [ ] All obsolete media produces cleanup obligations in the same transaction as the reset.
- [ ] The existing Reset route and Studio cloud adapter keep their request, success, and revision-conflict contracts; known validation outcomes do not fall through as opaque errors.
- [ ] Deterministic interface tests cover no original, repeated Reset, stale Reset, unsafe original media, purged source, changed and unchanged windows, deleted-range changes, and injected failures.
- [ ] Isolated PostgreSQL tests prove Reset races, one-revision settlement, atomic invalidation, immutable-original retention, and zero-write no-ops.
- [ ] The old Reset persistence orchestration is removed after the route moves.
- [ ] Focused tests, the repository typecheck, and the repository test command pass.
