# 01 — Establish the canonical persistence tracer through cloud save

**What to build:** Make canonical Clip Editor Document reads and full cloud saves run through one Clip Editor Document Persistence module, so a successful save commits one revision, the correct dependent invalidations, and recoverable obsolete-media cleanup without changing the Studio Editing Session or editor HTTP contract.

**Blocked by:** None — can start immediately.

**Status:** done

**Specification:** [Deepen Clip Editor Document persistence](../spec.md)

- [x] The domain glossary and an ADR define Clip Editor Document Persistence as the server owner of canonical document storage, revision fencing, database invalidation, and cleanup intent while preserving Studio Editing Session and Clip Composition Plan ownership.
- [x] The public module supports reading one document, mutating one document with a typed intent, and mutating a bounded project selection with a coherent typed intent; only read and full-replacement behavior need production adapters in this ticket.
- [x] One codec materializes the canonical document from stored columns, applies current null defaults, rejects malformed non-null values with a typed outcome, and encodes validated document-owned JSON without double casts.
- [x] Canonical equality is owned by the codec and is used for semantic no-op detection and exact lost-response acknowledgement.
- [x] Existing editor reads, server-rendered Studio seed reads, and full revision-guarded saves call the module without changing their successful status codes or response shapes.
- [x] A canonical no-op performs no database write, revision bump, original capture, render invalidation, derived-state invalidation, or cleanup insertion.
- [x] A stale full replacement returns the current revision, while an exact canonical document that already committed is acknowledged at the stored revision without another write.
- [x] The first real full replacement captures the pre-change canonical document as the immutable original, and later saves cannot replace it.
- [x] Boundary, timeline, media-safety, and renderability validation runs before commit and produces the existing typed user-facing outcomes.
- [x] One invalidation plan determines mutable Clip Render deletion, preview and peaks retirement, duration-score recomputation, and Automatic, explicit Split, and Screen evidence invalidation from the canonical current and next documents.
- [x] The document write, one revision increment, first-original capture, mutable render deletion, derived-column changes, and deduplicated cleanup obligations commit atomically.
- [x] Immutable Clip Exports and their variants remain available at their frozen revisions.
- [x] Obsolete-media cleanup is represented durably in the transaction, and the user-facing save never waits for object deletion.
- [x] Deterministic tests call only the public module interface for no-op, real save, lost response, stale revision, validation, original capture, invalidation, and injected transaction failure.
- [x] Isolated PostgreSQL tests prove one winner for concurrent saves and prove that document, revision, invalidations, render deletion, original, and cleanup obligations cannot commit partially.
- [x] The moved read and full-save paths have one persistence owner; their prior Clip Service orchestration is removed rather than retained as a fallback.
- [x] Focused tests, the repository typecheck, and the repository test command pass.
