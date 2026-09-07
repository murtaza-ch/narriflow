# 05 — Move Project library and Clip editing through policy

**What to build:** Move the remaining Project library, transcript, Clip, Studio, and Clip Editor Document request paths through Authenticated Request Policy. Reading, editing, duplicating, deleting, resetting, and bulk editing should use exact capabilities and one Project admission while preserving Studio Editing Session and Clip Editor Document Persistence behavior.

**Blocked by:** 03 — Recover Workspace and Project admission.

**Status:** done

- [x] Project library reads and mutations declare `content.view` or `content.edit` according to product intent rather than HTTP method.
- [x] Transcript, Clip, Studio, and Clip Editor Document requests reuse the admitted Actor Scope and active Project without repeating request-level access checks.
- [x] Nested Clip and document ownership remains enforced by the owning domain module, including races where a resource disappears after admission.
- [x] Existing successful status codes, payloads, redirects, revalidation, Studio cloud behavior, revision conflicts, Reset behavior, and bulk-edit results remain unchanged.
- [x] Authentication loss, permission loss, Workspace mismatch, missing Project or Clip, validation rejection, revision conflict, contention, and temporary persistence failure remain distinct browser outcomes.
- [x] Attempted titles, boundaries, transcript edits, caption settings, B-roll choices, and Studio edits survive expected correction or retry paths.
- [x] Known Clip and persistence errors use typed codes and safe messages without string comparison or raw exception leakage.
- [x] The common browser classifier handles shared failures while Studio Editing Session retains its richer Device Draft, ownership, conflict, and convergence behavior.
- [x] Moved routes and actions remove direct actor resolution, repeated capability and Project checks, handwritten common responses, and redundant shallow tests.
- [x] Policy, HTTP, action, browser, Studio, and Clip Editor Document Persistence tests prove the complete slice.
