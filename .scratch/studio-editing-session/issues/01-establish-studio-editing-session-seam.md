# 01 — Establish the Studio Editing Session seam through document edits and history

**What to build:** Make existing Studio document edits, timeline segment actions, gesture coalescing, and undo/redo flow through one tab-local Studio Editing Session while preserving the current user experience through a temporary React compatibility adapter.

**Blocked by:** None — can start immediately.

**Status:** completed

- [x] The agreed Studio Editing Session, Clip Editor Document, Device Draft, and Studio Write Ownership terms are recorded in the domain glossary.
- [x] The accepted deep-module decision is recorded in an ADR, including React-as-adapter and explicit persistence/export exclusions.
- [x] The session exposes only snapshot, subscription, synchronous intent, and typed asynchronous operation entry points.
- [x] Existing document and segment edits update the session snapshot synchronously and preserve current no-op behavior.
- [x] Document and segment undo/redo remain globally ordered, and gesture completion prevents cross-gesture coalescing.
- [x] A React compatibility adapter maps existing callers onto the session without owning history sequencing.
- [x] Behavior tests drive edits, segments, coalescing, undo, and redo only through the session interface.
- [x] No persistence, ownership, proxy, or playback protocol has two active owners during this slice.
- [x] No database, HTTP contract, Workflow Run, or Ingest Job migration is introduced.
- [x] Repository typecheck and tests pass.
