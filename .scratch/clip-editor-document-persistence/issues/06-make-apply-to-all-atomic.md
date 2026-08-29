# 06 — Make Apply to all one atomic project mutation

**What to build:** Apply caption and related Studio layout choices to the selected project clips as one canonical project mutation, so one user gesture cannot partially update other clips and each target keeps its unrelated document settings.

**Blocked by:** 05 — Make presentation edits invalidation-complete.

**Status:** done

**Specification:** [Deepen Clip Editor Document persistence](../spec.md)

- [x] Apply to all calls the project-selection operation on Clip Editor Document Persistence rather than maintaining separate caption and Studio edit persistence loops.
- [x] The operation accepts one caption intent or one coherent group of related Studio edit patches and applies that group as one revision per changed target clip.
- [x] Existing single-patch requests remain accepted, while the web adapter uses grouped patches for one layout gesture that currently requires related field changes.
- [x] The requested open clip is excluded before planning so the Studio Editing Session retains cloud-save ownership for its local document.
- [x] Every target document is canonicalized and validated before any target changes.
- [x] A malformed target, invalid patch, revision race that cannot be retried, or transaction failure leaves every selected clip unchanged.
- [x] Each changed target preserves unrelated caption, transcript, B-roll, boundary, deleted-range, and Studio edit values.
- [x] Canonical no-op targets keep their revisions, originals, renders, derived state, and cleanup obligations unchanged.
- [x] Each real target change captures its original if needed, increments its revision exactly once, retires mutable renders, and records deduplicated cleanup obligations in the same transaction.
- [x] Project-selection mutations retain preview, scores, and composition evidence because supported bulk intents do not change source-window or deleted-range inputs.
- [x] The response reports the number of changed other clips, and zero means every selected clip already matched.
- [x] Apply controls prevent duplicate submission, show changed-count or already-matched success, and retain the local open-clip edit when the project mutation fails.
- [x] Related Auto or Center layout changes use one request, so background-off and framing cannot commit separately.
- [x] Deterministic interface tests cover exclusion, mixed no-op and changed targets, preservation of per-clip values, grouped patches, malformed documents, and rollback.
- [x] Isolated PostgreSQL tests prove all-or-nothing settlement, one revision per changed clip, concurrent mutation handling, render invalidation, and cleanup insertion.
- [x] Old bulk persistence orchestration and silent malformed-row skipping are removed after cutover.
- [x] Focused service and web tests, the repository typecheck, and the repository test command pass.
