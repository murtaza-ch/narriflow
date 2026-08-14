# 04 — Converge cloud revisions inside the Studio Editing Session

**What to build:** Reconcile newer cloud documents with device work inside the session so React never implements revision fetching, three-way merging, conflict blocking, or recovery sequencing.

**Blocked by:** 03 — Make cloud checkpoints single-flight and retryable.

**Status:** completed

- [x] Takeover, bfcache resume, and revision conflicts refresh the cloud head before editing continues.
- [x] Disjoint plain-object changes merge automatically against the last confirmed cloud document.
- [x] Independently changed ordered arrays and overlapping leaf values enter an explicit conflict state.
- [x] Conflict state blocks mutations and cloud checkpoints while preserving the Device Draft.
- [x] Keeping cloud replaces the working document, removes the obsolete draft, and establishes a fresh history root.
- [x] Keeping device rebases the whole device document onto the latest cloud revision and resumes checkpointing.
- [x] Every runtime convergence clears undo and redo so snapshots from an older baseline cannot replay.
- [x] Stale cloud responses are ignored by session and document generation.
- [x] The temporary React revision-conflict protocol introduced for migration is removed.
- [x] Interface tests cover automatic merge, ordered-array conflicts, both conflict choices, history reset, resume refresh, and stale responses.
- [x] Exactly one module owns cloud convergence after cutover.
- [x] Repository typecheck and tests pass.
