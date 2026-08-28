# Deepen Clip Editor Document persistence

**Status:** ready-for-agent

## Problem Statement

People editing a clip expect every accepted change to become one coherent Clip Editor Document. They also expect previews, analyses, renders, and Reset to original to agree with that document. Today post-creation document persistence is spread across full-document save, reset, boundary, transcript, caption, B-roll, Studio edit, and project-wide apply paths. Each path separately decides whether a change is a no-op, how to bump the revision, which derived records become stale, whether to preserve the original document, and how to delete obsolete media.

Those decisions already disagree. Some field updates can leave completed renders that no longer match the clip. Some no-op updates still advance the revision. Boundary rules and source-availability checks differ by entry point. Bulk updates can partially apply one user gesture. Object-deletion failures are discarded after the database has removed the last reference. Existing tests cover the pure planning helpers well, but they do not prove the database transaction and cleanup obligations through the interface that performs a real mutation.

This makes ordinary editor work vulnerable to stale output, avoidable revision conflicts, lost reset baselines, partial bulk changes, and storage leaks. It also makes adding fields to the Clip Editor Document risky because every caller must rediscover the same persistence rules.

## Solution

Introduce one deep Clip Editor Document Persistence module for every post-creation document read and mutation. Callers will state an actor scope and a typed mutation intent. The module will load and canonicalize the current document, apply the intent, detect semantic no-ops, fence concurrent writes, preserve the original document, commit the document and every database invalidation atomically, and record durable cleanup obligations for obsolete media.

The existing Studio Editing Session remains the client-side owner of working edits, history, Device Draft durability, cloud convergence, preview eligibility, and playback. Existing HTTP routes and successful response shapes remain in place as adapters to the new module. Immutable Clip Exports remain available at their frozen revisions. A worker will claim and retry cleanup obligations after the user-facing transaction commits, so an object-store outage cannot turn a valid edit into a failed save or an invisible leak.

## User Stories

1. As a clip editor, I want every accepted change reflected in one canonical Clip Editor Document, so that Studio, preview, and export agree.
2. As a clip editor, I want an unchanged save treated as a no-op, so that it does not create a false revision conflict.
3. As a clip editor, I want an unchanged field update treated as a no-op, so that valid renders are not discarded.
4. As a clip editor, I want an unchanged Reset request treated as a no-op, so that repeated Reset presses are harmless.
5. As a clip editor, I want a lost successful save response acknowledged when I retry the same canonical document, so that recovery does not manufacture a conflict.
6. As a clip editor, I want a stale full-document save rejected with the current revision, so that another edit is never overwritten.
7. As a clip editor, I want older field-specific screens to apply their intent to the latest document, so that they cannot overwrite unrelated Studio work.
8. As a clip editor, I want sustained concurrent editing reported as a retryable conflict, so that my input remains available instead of failing ambiguously.
9. As a clip editor, I want the first real post-creation edit to preserve the pre-edit document, so that Reset to original has one stable meaning.
10. As a clip editor, I want later edits to leave the preserved original unchanged, so that Reset does not drift over time.
11. As a clip editor, I want Reset to restore the complete original document, so that no caption, transcript, layout, B-roll, cut, or boundary setting is left behind.
12. As a clip editor, I want invalid saved document data rejected before any write, so that malformed state cannot enter the render pipeline.
13. As a clip editor, I want an invalid stored document reported safely, so that Narriflow does not silently replace or partially interpret it.
14. As a clip editor, I want transcript words and deleted ranges canonicalized to the accepted clip window, so that persisted timing cannot disagree with playback.
15. As a clip editor, I want a boundary change rejected when it is too short, too long, negative, reversed, or beyond a known source duration, so that the clip remains renderable.
16. As a clip editor, I want a boundary change rejected after source media has been removed, so that the preview is not invalidated without a way to rebuild it.
17. As a clip editor, I want a deletion rejected when it leaves no frame-safe content, so that a save cannot create an unrenderable clip.
18. As a clip editor, I want all accepted external media references to pass the current safety policy, so that a reset or alternate mutation route cannot bypass validation.
19. As a clip editor, I want any real export-affecting document change to retire current render rows, so that stale downloads are never presented as current.
20. As a clip editor, I want immutable Clip Exports from older revisions preserved, so that previously frozen delivery artifacts remain available.
21. As a clip editor, I want a boundary change to retire the old preview proxy and waveform peaks together, so that playback never uses the wrong source window.
22. As a clip editor, I want caption, audio, and styling changes to keep an eligible preview proxy, so that cheap edits do not trigger unnecessary media work.
23. As a clip editor, I want source-window and deleted-range changes to invalidate incompatible layout evidence, so that Studio and export do not adopt stale analysis.
24. As a clip editor, I want unrelated document changes to retain eligible layout evidence, so that analysis is not repeated without cause.
25. As a clip editor, I want duration-dependent scores recomputed only when the clip window changes, so that scores stay correct without unnecessary work.
26. As a clip editor, I want obsolete media cleanup to happen after my document commit, so that object-store latency does not slow autosave.
27. As a clip editor, I want a temporary object-store failure to leave my accepted edit intact, so that cleanup cannot roll back user work.
28. As an operator, I want every obsolete media key recorded before its database reference disappears, so that a process crash cannot lose the cleanup obligation.
29. As an operator, I want cleanup claims fenced and recoverable after worker failure, so that two workers cannot settle one obligation incorrectly.
30. As an operator, I want missing objects treated as successful cleanup, so that retries remain idempotent.
31. As an operator, I want failed cleanup retried with bounded backoff, so that temporary provider failures heal without a manual database edit.
32. As an operator, I want cleanup failures and recoveries logged with stable codes, so that storage leaks are visible and searchable.
33. As an operator, I want cleanup diagnostics to omit document contents and private media locations, so that logs do not expose user material.
34. As a clip editor, I want Apply to all to skip clips that already match, so that their revisions and renders remain untouched.
35. As a clip editor, I want Apply to all to exclude my open clip when requested, so that the Studio Editing Session can save its local copy without a self-created conflict.
36. As a clip editor, I want one layout gesture that changes related fields applied atomically to other clips, so that they cannot receive half of the intended layout.
37. As a clip editor, I want a failed project-wide apply to leave every target clip unchanged, so that I can retry from a known state.
38. As a clip editor, I want Apply to all to report how many other clips changed, so that success and a no-op are distinguishable.
39. As a clip editor, I want a project-wide apply to preserve each target clip's own unrelated settings, so that one shared choice does not clone the source document.
40. As a clip editor, I want the current editor URLs, methods, and success payloads to continue working, so that the persistence refactor does not interrupt my workflow.
41. As a clip editor, I want validation, conflict, missing-resource, and temporary-service failures to remain distinct, so that the interface can show the right recovery action.
42. As a clip editor, I want my typed input retained when a retryable mutation fails, so that retrying does not require recreating the edit.
43. As a Studio maintainer, I want the Studio Editing Session cloud adapter to keep its existing contract, so that client-side durability and convergence do not need a second migration.
44. As a service maintainer, I want one typed document-to-database codec, so that Prisma JSON casts cannot bypass validation for document-owned fields.
45. As a service maintainer, I want one canonical equality policy, so that no-op and lost-response decisions do not depend on caller-specific serialization.
46. As a service maintainer, I want one invalidation policy derived from the changed document fields, so that a new mutation path cannot forget a dependent artifact.
47. As a service maintainer, I want one revision policy for every post-creation document mutation, so that concurrency rules are local and testable.
48. As a service maintainer, I want creation paths to use the same document codec when initializing document-owned columns, so that newly created clips start in canonical form.
49. As a service maintainer, I want orchestration tests to call the public persistence interface, so that internal refactors do not rewrite the behavior suite.
50. As a service maintainer, I want real PostgreSQL tests for revision and transaction invariants, so that in-memory tests cannot hide database races.
51. As a service maintainer, I want transport tests limited to HTTP mapping, so that business rules do not return to route handlers.
52. As a service maintainer, I want the old persistence orchestration removed after each path moves, so that two modules never own the same mutation.

## Implementation Decisions

- Add Clip Editor Document Persistence to the project language as the server-side module that owns canonical post-creation document storage, revision fencing, dependent database invalidation, and obsolete-media cleanup intent. It does not own the Studio Editing Session or Clip Composition Plan.
- The public interface has three forms: read one document, mutate one document with a typed intent, and mutate a bounded project selection with one coherent typed intent. Reset and full replacement are mutation intents, not separate persistence implementations.
- Single-document intents cover full replacement, Reset to original, boundaries, caption preset, transcript slice, B-roll, and Studio edits. Project-selection intents cover caption preset and an atomic set of related Studio edit patches.
- Callers provide the current actor and project scope. This work preserves the existing authorization semantics and does not redesign Workspace identity or request policy.
- Existing editor GET, PUT, Reset, field PATCH, and Apply to all routes remain transport adapters. Their current successful status codes and response shapes remain stable. Additive request support may group related bulk patches into one atomic user action.
- The Studio Editing Session cloud contract remains unchanged. Full replacement and Reset continue to carry a base revision. Revision conflicts continue to return the current cloud revision.
- Full replacement and Reset use compare-and-swap semantics and never retry against a newer document on the caller's behalf. An exact canonical retry of a document that already committed is acknowledged without another write.
- Field-specific mutations that do not carry a base revision apply their typed intent to the latest canonical document. The module uses bounded transactional retries when another writer changes the revision during planning. Exhausted contention produces a typed retryable outcome and never applies a stale whole-document snapshot.
- A real mutation increments the editor revision exactly once. A semantic no-op performs no database write, does not capture an original, does not invalidate dependent state, and does not create cleanup work.
- The module captures the pre-change canonical document as the immutable original during the first real post-creation mutation, regardless of which supported mutation path performs it. Later mutations never replace that original.
- The Clip table remains the storage projection for the document's individual fields. This work does not add a second whole-document column or dual-write two document shapes. A single mapper materializes the canonical document from those columns and a single encoder produces their validated database values.
- Current null semantics remain part of canonical materialization: an absent caption preset resolves to the current default, absent Studio edits resolve to their schema defaults, and absent deleted ranges resolve to an empty list. A malformed non-null document-owned value fails with a typed corruption outcome. The module does not silently drop fields or substitute an older parser.
- The typed encoder accepts only schema-validated document values and recursively produces Prisma-compatible JSON values. Document-owned persistence contains no double casts or raw JSON-to-domain assertions.
- Canonical equality is owned by the document codec. It compares canonical schema output and may cache one serialization or fingerprint per mutation. A new persisted hash column is not introduced because current document sizes and read requirements do not justify another synchronization invariant.
- Initialization paths for detected, duplicated, and selection-created clips use the same codec for document-owned JSON values. Initialization does not create an editor revision or cleanup obligation because no prior document exists.
- One invalidation planner compares the canonical current and next documents. It returns the exact database changes and obsolete media keys. Callers never select invalidations themselves.
- Every real Clip Editor Document change marks the clip edited and invalidates mutable current Clip Render rows. Clip Exports and their variants remain immutable and are not deleted because they are frozen to an editor revision.
- A clip-window change invalidates the preview proxy and its derived waveform peaks, recomputes duration-dependent platform scores, and requires available source media before commit.
- A clip-window or deleted-range change invalidates all durable composition evidence whose declared inputs no longer match, including Automatic, explicit Split, and Screen evidence. Caption, transcript text, B-roll, audio, and styling changes retain evidence whose source-window and deleted-range inputs still match.
- A transcript-only mutation remains clamped to the accepted clip window. It invalidates current renders but does not move boundaries, discard the preview, or repeat visual analysis.
- Empty-timeline, duration, source-range, and public-media validation run before the transaction commits. Reset passes through the same validation and invalidation policy as any other mutation rather than trusting the stored original blindly.
- The guarded document write, original capture, mutable render-row deletion, derived-column invalidation, and creation of storage-cleanup obligations commit in one database transaction. A failed transaction leaves all of them unchanged.
- Obsolete media deletion never runs inside the document transaction and never delays the success response. The transaction records one deduplicated cleanup obligation per exact object key, including preview peaks derived from a retired proxy.
- Cleanup obligations are durable, independently claimable records with attempt count, next-attempt time, claim identity, claim expiry, stable failure code, and completion time. Claims are fenced. An expired claim is recoverable by another worker.
- The worker deletes only the exact recorded key. Provider not-found is success. Temporary failures retry with jittered exponential backoff capped at a configured interval. Permanent configuration failures remain visible and due after the cap rather than being silently discarded.
- Existing orphan reconciliation remains a defense for objects created before a database reference was committed. Cleanup obligations own deletion after a document mutation deliberately removes a reference; the two mechanisms do not compete to mutate the Clip Editor Document.
- Structured diagnostics record actor-safe identifiers, project and clip IDs, mutation kind, base and resulting revision, no-op status, invalidation classes, cleanup count, typed outcome, attempt count, and elapsed time. They never record document contents, captions, transcripts, URLs, storage keys, or provider response bodies.
- Project-selection mutation loads and validates every target document before writing. It preserves unrelated per-clip values, skips canonical no-ops, excludes the requested open clip, and commits all affected rows and cleanup obligations atomically.
- Related layout changes from one UI gesture travel as one project-selection intent. The web adapter no longer issues a sequence where the first half can commit and the second half can fail.
- Bulk results preserve the current changed-row count. A zero count means every selected target already matched. A validation, corruption, or transaction failure changes no selected clip.
- Known domain outcomes map consistently at every HTTP adapter: missing resources, forbidden access, stale revision, invalid boundaries, empty timeline, unsafe media, corrupt stored document, transient contention, and unavailable persistence. Known outcomes do not fall through as opaque exceptions.
- User-facing save and bulk controls preserve the attempted value after retryable failure, prevent duplicate submission while active, and distinguish a conflict or temporary failure from validation. Background cleanup failure does not change a successful edit into an error because the cleanup obligation is already durable.
- Migration moves one intent family at a time behind the new module. A moved route or service caller cannot retain a second implementation of revision, invalidation, or cleanup rules. After the last caller moves, obsolete Clip Service persistence planners, mutation methods, casts, and shallow orchestration tests are removed.
- The repository's pre-production policy applies. No dual reads, dual writes, legacy fallback persistence, shadow mode, or cutover switch remains after the final ticket.

## Testing Decisions

- The public Clip Editor Document Persistence interface is the primary and highest behavior-test seam. Tests observe returned documents and typed outcomes, then inspect only externally durable effects such as the stored revision, Clip Render membership, derived-state eligibility, and cleanup obligations.
- The behavior suite runs the real module with deterministic in-memory persistence, cleanup, time, and diagnostics adapters. It covers exhaustive intent and failure combinations without asserting private helper calls or transaction statement order.
- The same public interface runs against a real isolated PostgreSQL schema for database invariants. This follows the repository's Workflow Run, Upload Session, Workspace Billing, and Social Publication database-test pattern.
- PostgreSQL tests prove that two full replacements from one base revision cannot both commit, an exact lost-response retry is acknowledged, a field intent racing a full replacement never overwrites unrelated fields, and an exhausted transaction leaves no partial document or invalidation changes.
- PostgreSQL tests prove that document columns, the revision, first original, mutable render deletion, preview and analysis invalidation, score changes, and cleanup obligations commit atomically.
- PostgreSQL tests prove that a no-op causes zero revision, render, derived-state, and cleanup changes.
- PostgreSQL tests prove that the original is captured once across full save, field update, Reset, and bulk entry paths and cannot be replaced by later work.
- Table-driven interface tests cover the invalidation matrix for boundaries, deleted ranges, transcript, caption, B-roll, Studio visual edits, Studio audio edits, and combinations. Tests assert retained state as carefully as invalidated state.
- Interface tests cover minimum and maximum duration boundaries, unknown and known source duration, purged source media, complete deletion, sub-frame kept slivers, transcript overlap at both clip edges, unsafe media, and Reset to an original that no longer passes current safety policy.
- Interface tests cover exact no-ops, canonical defaults, reordered or independently allocated equivalent values, first-save original capture, repeated Reset, stale Reset, and malformed stored JSON.
- Bulk interface tests cover excluded open clips, mixed matching and changed rows, preservation of unrelated fields, one atomic multi-field layout gesture, revision races, malformed target documents, and transaction rollback. No test accepts partial success for one project-selection intent.
- Cleanup behavior tests cover deduplication, immediate success, provider not-found, temporary failure, capped backoff, expired-claim recovery, stale claimant settlement, repeated delivery, and diagnostic failure. Document mutation remains successful in every post-commit cleanup case.
- PostgreSQL cleanup tests prove one durable obligation survives a process boundary, only the current claim can settle it, and a recovered worker can claim expired work.
- Focused HTTP contract tests cover request compatibility and status mapping only. They do not duplicate document planning or invalidation tables.
- Existing Editor Document validator, reducer, timing, caption, composition-evidence, Studio Editing Session, Clip Composition Plan, and Clip Render Attempt tests remain because they define independent contracts.
- Existing pure planning tests may remain where they define timing or validation policy. Tests that only restate persistence orchestration are removed after equivalent behavior exists at the module seam.
- Completion verification includes focused service and database tests, worker cleanup tests, the repository typecheck, and the repository test command. The affected production build and lint checks run before final cutover because the web and worker adapters both change.
- Real-browser verification covers full-document autosave, retry after an interrupted response, stale-tab conflict recovery, Reset, boundary preview replacement, Apply to all success and no-op copy, atomic related layout changes, and retained user input after a retryable failure.

## Out of Scope

- Changing Studio Editing Session ownership, Device Draft storage, Studio Write Ownership, client history, cloud convergence, or playback authority.
- Collaborative editing, operation logs, event-sourced editor history, or per-field conflict resolution between devices.
- Changing Clip Composition Plan policy, renderer geometry, media analysis models, detector thresholds, or evidence formats.
- Changing Clip Render Attempt lifecycle, immutable Clip Export behavior, Social Post freezing, or publication revision policy.
- Redesigning Workspace authorization, actor identity, authenticated request policy, or string error handling outside editor document routes.
- Removing current editor HTTP routes or requiring field-specific clients to send a full document.
- Eliminating every Prisma JSON cast in Clip Service. This work removes unsafe conversions for Clip Editor Document fields and their initialization paths; unrelated LLM, analysis, and provider payloads belong to their own modules.
- A generic migration of every storage deletion in Narriflow. The durable cleanup mechanism supports document-mutation invalidations first; unrelated deletion flows move only under a separate approved effort.
- Persisting a complete Clip Editor Document in a new second column or adding a document hash solely for performance.
- Changing title editing. A clip title is display metadata and is not part of the Clip Editor Document.
- Preserving malformed local-only test data through fallback readers. Local fixtures must be corrected or reset to the current canonical document contract.

## Further Notes

- The previous Studio Editing Session work deliberately left server-side persistence outside its boundary. This module meets that reserved responsibility without moving browser protocol ownership back into services.
- Current per-field routes are product adapters, not alternate document owners. Keeping an HTTP route does not justify keeping its persistence logic in Clip Service.
- The invalidation planner should be conservative about user-visible correctness and precise about expensive derived work. Stale renders are never retained, while previews and analysis survive changes that do not affect their declared inputs.
- Durable cleanup is part of the mutation contract because database deletion removes the only ordinary reference to an object. Recording the obligation in the same transaction closes the crash window without making autosave depend on object storage.
- Work proceeds through the blocking edges in the approved local tickets. Each ticket must leave exactly one owner for every mutation path it moves.
