# 05 — Own Clip Editor Document equality in validators

**What to build:** Give Clip Editor Document equality one typed shared owner and use it for Studio and persistence decisions. Semantically unchanged documents must remain no-ops, real changes must remain dirty, and common early differences must avoid serializing the full transcript-bearing document.

**Blocked by:** None — can start immediately.

**Status:** done

**Specification:** [Close the remaining architecture findings](../spec.md)

- [x] The shared validators module exposes typed Clip Editor Document and deleted-range equality interfaces.
- [x] Both comparators use a reference fast path and field-aware early exits rather than unconditional complete-document serialization.
- [x] Ordered arrays such as transcript utterances, words, layers, placements, and overrides remain order-sensitive.
- [x] Deleted ranges are normalized before domain equality so equivalent differently ordered or overlapping inputs compare equal after validation.
- [x] Equality never replaces schema parsing, document canonicalization, revision checks, or invalidation policy.
- [x] Studio Editing Session dirty state, cloud convergence, Device Draft checkpoint and removal, Reset eligibility, and derived-media invalidation use the shared typed rules.
- [x] Clip Editor Document Persistence uses the same rules only after stored or untrusted documents have crossed its canonical codec.
- [x] Generic recursive three-way draft merging keeps its local arbitrary-JSON comparison; only whole-document decisions use the typed document comparator where appropriate.
- [x] Composition fingerprints, publication intent keys, upload resume identity, small form dirty checks, and cache signatures remain under their current modules.
- [x] No repository-wide stable-JSON or generic deep-equality module is introduced.
- [x] Persisted document shape, revision semantics, request and response payloads, composition fingerprints, and Studio collaboration behavior remain unchanged.
- [x] Comparator tests cover identical references, separately allocated equality, property insertion order before parsing, one change in every top-level field, ordered-array reordering, and normalized equivalent deleted ranges.
- [x] Studio Editing Session tests prove equal documents do not create history, mark cloud state dirty, protect navigation, or retain a redundant Device Draft, while every real change remains dirty until acknowledged.
- [x] Persistence tests prove exact no-op revisions remain stable and real window or deleted-range changes still trigger their declared derived-media invalidation.
- [x] Representative large-document tests verify behavior after an early scalar difference without using a fragile wall-clock threshold as the sole assertion.
- [x] Focused validator, Studio Editing Session, Clip Editor Document Persistence, typecheck, lint, and fast aggregate tests pass.

## Completion evidence — 2026-08-30

- Validators now own field-aware `editorDocumentsEqual` and normalized `deletedRangesEqual`; Studio, Device Draft whole-document decisions, and persistence consume that shared policy after their existing validation boundaries.
- Comparator, Studio session/cloud, Device Draft, persistence, typecheck, lint, and fast aggregate suites pass. Authenticated Chrome proved an equal preset selection remains a no-op and a real preset change stays dirty until cloud acknowledgement.
