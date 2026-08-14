# 04 — Converge cloud revisions inside the Studio Editing Session

**What to build:** Reconcile newer cloud documents with device work inside the session so React never implements revision fetching, three-way merging, conflict blocking, or recovery sequencing.

**Blocked by:** 03 — Make cloud checkpoints single-flight and retryable.

**Status:** ready-for-agent

- [ ] Takeover, bfcache resume, and revision conflicts refresh the cloud head before editing continues.
- [ ] Disjoint plain-object changes merge automatically against the last confirmed cloud document.
- [ ] Independently changed ordered arrays and overlapping leaf values enter an explicit conflict state.
- [ ] Conflict state blocks mutations and cloud checkpoints while preserving the Device Draft.
- [ ] Keeping cloud replaces the working document, removes the obsolete draft, and establishes a fresh history root.
- [ ] Keeping device rebases the whole device document onto the latest cloud revision and resumes checkpointing.
- [ ] Every runtime convergence clears undo and redo so snapshots from an older baseline cannot replay.
- [ ] Stale cloud responses are ignored by session and document generation.
- [ ] The temporary React revision-conflict protocol introduced for migration is removed.
- [ ] Interface tests cover automatic merge, ordered-array conflicts, both conflict choices, history reset, resume refresh, and stale responses.
- [ ] Exactly one module owns cloud convergence after cutover.
- [ ] Repository typecheck and tests pass.
