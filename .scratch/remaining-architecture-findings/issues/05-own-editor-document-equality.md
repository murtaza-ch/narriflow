# 05 — Own Clip Editor Document equality in validators

**What to build:** Give Clip Editor Document equality one typed shared owner and use it for Studio and persistence decisions. Semantically unchanged documents must remain no-ops, real changes must remain dirty, and common early differences must avoid serializing the full transcript-bearing document.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

**Specification:** [Close the remaining architecture findings](../spec.md)

- [ ] The shared validators module exposes typed Clip Editor Document and deleted-range equality interfaces.
- [ ] Both comparators use a reference fast path and field-aware early exits rather than unconditional complete-document serialization.
- [ ] Ordered arrays such as transcript utterances, words, layers, placements, and overrides remain order-sensitive.
- [ ] Deleted ranges are normalized before domain equality so equivalent differently ordered or overlapping inputs compare equal after validation.
- [ ] Equality never replaces schema parsing, document canonicalization, revision checks, or invalidation policy.
- [ ] Studio Editing Session dirty state, cloud convergence, Device Draft checkpoint and removal, Reset eligibility, and derived-media invalidation use the shared typed rules.
- [ ] Clip Editor Document Persistence uses the same rules only after stored or untrusted documents have crossed its canonical codec.
- [ ] Generic recursive three-way draft merging keeps its local arbitrary-JSON comparison; only whole-document decisions use the typed document comparator where appropriate.
- [ ] Composition fingerprints, publication intent keys, upload resume identity, small form dirty checks, and cache signatures remain under their current modules.
- [ ] No repository-wide stable-JSON or generic deep-equality module is introduced.
- [ ] Persisted document shape, revision semantics, request and response payloads, composition fingerprints, and Studio collaboration behavior remain unchanged.
- [ ] Comparator tests cover identical references, separately allocated equality, property insertion order before parsing, one change in every top-level field, ordered-array reordering, and normalized equivalent deleted ranges.
- [ ] Studio Editing Session tests prove equal documents do not create history, mark cloud state dirty, protect navigation, or retain a redundant Device Draft, while every real change remains dirty until acknowledged.
- [ ] Persistence tests prove exact no-op revisions remain stable and real window or deleted-range changes still trigger their declared derived-media invalidation.
- [ ] Representative large-document tests verify behavior after an early scalar difference without using a fragile wall-clock threshold as the sole assertion.
- [ ] Focused validator, Studio Editing Session, Clip Editor Document Persistence, typecheck, lint, and fast aggregate tests pass.

