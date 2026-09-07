# Deepen the Studio Editing Session

**Status:** ready-for-agent

## Problem Statement

People editing a clip rely on Narriflow to keep every change safe and to make the preview represent the document they are editing. Today the editing protocol is distributed across a large React shell, effects, refs, and small helpers. Correctness depends on the ordering between document history, IndexedDB writes, browser tab ownership, cloud revision saves, retry timers, preview invalidation, and media-element reconciliation. The helpers are individually tested, but no test drives the sequencing a real editing session performs. This makes changes risky and leaves races in the orchestration between otherwise-correct helpers.

## Solution

Introduce one deep, clip-scoped, tab-local Studio Editing Session module. React will render immutable session snapshots and forward user intent. The session will own the working Clip Editor Document and history, Device Draft durability, Studio Write Ownership, cloud checkpointing and convergence, preview eligibility, and authoritative source-anchored playback. Production browser behavior and deterministic tests will use adapters behind private seams. The existing server persistence and export contracts remain in place.

## User Stories

1. As a clip editor, I want an edit to appear immediately, so that Studio feels responsive.
2. As a clip editor, I want every accepted edit to enter one undo history, so that undo follows the order of my actions.
3. As a clip editor, I want one continuous gesture to create one undo step, so that sliders and drags are practical to undo.
4. As a clip editor, I want timeline segment actions and document actions to undo in the order I performed them, so that history is predictable.
5. As a clip editor, I want a recovered device draft to open automatically when it does not conflict, so that a crash does not cost work.
6. As a clip editor, I want newer cloud changes and my device draft merged when they affect different values, so that neither safe change is discarded.
7. As a clip editor, I want an explicit choice when device and cloud copies overlap, so that Narriflow does not guess which work matters.
8. As a clip editor, I want conflict choices to keep the full device or cloud document, so that resolution is understandable.
9. As a clip editor, I want editing blocked while a merge conflict is unresolved, so that I cannot build more work on an ambiguous baseline.
10. As a clip editor, I want undo history to restart after external cloud convergence, so that old snapshots are never replayed against a different baseline.
11. As a clip editor, I want edits saved on this device before the slower cloud checkpoint when possible, so that closing or crashing is safe.
12. As a clip editor, I want Studio to remain usable when browser draft storage is unavailable, so that a browser limitation does not block cloud editing.
13. As a clip editor, I want a visible degraded-durability state when local storage fails, so that I understand the remaining risk.
14. As a clip editor, I want a navigation warning only while the latest document is not device-durable, so that safe offline work does not trap me in Studio.
15. As a clip editor, I want cloud autosaves serialized, so that overlapping requests cannot overtake one another.
16. As a clip editor, I want edits made during a cloud save included in exactly one follow-up save, so that the latest document converges efficiently.
17. As a clip editor, I want a lost save response retried idempotently, so that a committed edit does not become a false conflict.
18. As a clip editor, I want transient cloud failures retried automatically, so that brief outages do not require manual recovery.
19. As a clip editor, I want offline edits synchronized as soon as connectivity returns, so that I can keep working through a network interruption.
20. As a clip editor, I want explicit Save to retry immediately, so that I can request convergence without waiting for backoff.
21. As a clip editor, I want semantic save rejection distinguished from connectivity failure, so that futile retries do not continue forever.
22. As a clip editor, I want to undo or correct a rejected document, so that one invalid edit does not force a reload.
23. As a clip editor, I want export preparation to wait for the exact current cloud revision, so that the exported clip matches Studio.
24. As a clip editor, I want a clean read-only tab to export the already-saved revision, so that browser ownership does not block safe delivery.
25. As a clip editor, I want reset to drain cloud saves before restoring the original, so that reset cannot race autosave.
26. As a clip editor, I want closing the session to release browser ownership and ignore late callbacks, so that reopening starts cleanly.
27. As a clip editor, I want only one browser tab to change a clip at a time, so that duplicate work and avoidable conflicts are prevented.
28. As a clip editor, I want other tabs to remain usable for inspection and playback, so that read-only safety is not a blank screen.
29. As a clip editor, I want takeover to checkpoint the previous tab before transferring control, so that its newest gesture is recoverable.
30. As a clip editor, I want a forced takeover when the prior tab is unresponsive, so that an abandoned browser lock cannot block me indefinitely.
31. As a clip editor, I want the new writer to reload device and cloud state before editing, so that takeover cannot save a stale in-memory copy.
32. As a clip editor, I want a visible degraded-coordination state when browser locking is unavailable, so that cloud revision conflicts are not surprising.
33. As a clip editor, I want stale prior writers fenced from Device Draft storage, so that a late write cannot overwrite the new writer's checkpoint.
34. As a clip editor, I want a boundary edit to stop using an ineligible proxy immediately, so that the preview never represents the wrong window.
35. As a clip editor, I want undo to reuse a still-valid proxy when it restores the exact unsaved window, so that unnecessary source loading is avoided.
36. As a clip editor, I want Studio to use the source while a replacement proxy is generated, so that trimming does not stop playback.
37. As a clip editor, I want stale proxy and layout polling responses ignored, so that old worker output cannot replace current media.
38. As a clip editor, I want waveform and automatic layout state invalidated with their inputs, so that related preview data cannot disagree.
39. As a clip editor, I want the same source frame preserved across trims and source swaps, so that I do not lose my place.
40. As a clip editor, I want playback to move to the next kept frame when my current frame is deleted, so that it never displays cut footage.
41. As a clip editor, I want playback to park on the last kept frame at the end, so that tail cuts do not reveal deleted footage.
42. As a clip editor, I want play state and rate preserved when Studio swaps proxy and source, so that regeneration is unobtrusive.
43. As a Studio maintainer, I want React to be a presentation adapter, so that protocol changes are localized outside rendering code.
44. As a Studio maintainer, I want one session interface to be the behavior-test surface, so that tests survive implementation refactors.
45. As a Studio maintainer, I want deterministic time, network, browser ownership, and media adapters, so that race scenarios are reproducible.
46. As a Studio maintainer, I want production adapter contract tests, so that in-memory behavior does not hide browser integration mistakes.
47. As a Studio maintainer, I want existing browser drafts upgraded lazily, so that deploying the new session cannot discard unsynced work.
48. As a Studio maintainer, I want each migration slice to have one protocol owner, so that rollout does not create duplicate saves, locks, or media commands.

## Implementation Decisions

- The Studio Editing Session is one tab-local module per clip. It is not a collaborative multi-tab document.
- The external interface has four entry points: read a snapshot, subscribe, dispatch a synchronous intent, and perform a typed asynchronous operation.
- Immediate intents cover document and segment mutations, gesture completion, history, and playback commands. Operations cover trim, cloud checkpoint, takeover, conflict resolution, reset, and close.
- The snapshot exposes grouped domain projections and capability flags. It does not expose timers, refs, queue states, attempt tokens, or DOM elements.
- React owns presentation-only state and supplies selector hooks and a media ref adapter.
- The session owns the complete working Clip Editor Document plus unified document and segment history.
- Startup trusts the server-rendered cloud seed, then resolves Device Draft recovery and Studio Write Ownership before accepting mutations.
- Takeover, bfcache resume, and revision conflicts refresh the cloud head before editing resumes.
- Conflict-free recovery and three-way convergence are automatic. Plain objects merge recursively; independently changed ordered arrays are conflicts.
- Conflict resolution chooses the whole device or cloud document. Runtime convergence creates a fresh history root.
- Device Draft writes precede cloud checkpoints when IndexedDB is available. IndexedDB failure degrades availability but does not block cloud editing.
- Device Draft records add a format and writer generation. Version-one records remain readable and are rewritten lazily. Conditional writes reject older generations.
- Browser coordination uses Web Locks first, BroadcastChannel for handoff, and an expiring local-storage lease as compatibility fallback. A two-second handoff timeout permits forced takeover.
- When all coordination mechanisms fail, the session becomes a degraded writer and relies on cloud revision fencing.
- Cloud saves are single-flight and versioned. Acknowledgements advance only the document version they carried.
- Transient failures are network errors, offline state, HTTP 408/425/429, and HTTP 5xx. They retry indefinitely with jittered exponential delays capped at thirty seconds.
- Authentication loss, missing clips, semantic rejection, and revision conflicts have distinct typed outcomes. A semantic rejection blocks cloud-current claims for that document but permits correction.
- `prepare-cloud-revision` is the only export durability barrier. Export creation and navigation remain outside the session.
- Reset drains the checkpoint chain, blocks new edits during the reset operation, and returns a reload-required outcome after success.
- Page close relies primarily on Device Draft durability. A keepalive write is attempted only when no regular save is active.
- Proxy descriptors have a document-window fingerprint. Boundary changes make mismatched proxies locally ineligible before cloud acknowledgement.
- Source media is the temporary playback asset while a replacement proxy is unavailable. Only matching proxy and automatic-layout results are adopted.
- Playback time is authoritative inside the session and anchored to source frames across document and media changes.
- The session commands a media adapter; React never seeks the HTML media element or mutates the playback clock directly.
- Server-side Clip Editor Document persistence, existing editor routes, export creation, and Postgres schemas are unchanged.
- Migration uses a compatibility React adapter and transfers one protocol at a time. There must never be two active owners for one protocol.

## Testing Decisions

- The Studio Editing Session interface is the highest and primary test seam. Tests observe snapshots and operation results rather than private transitions.
- The real implementation runs with deterministic in-memory cloud, draft, coordination, runtime, and media adapters plus a manual clock.
- Interface tests cover recovery, rapid edits during a save, lost responses, offline and reconnect, semantic rejection correction, conflict convergence, conflict choices, ownership loss, cooperative and forced handoff, stale callbacks, proxy replacement, source-anchored playback, export preparation, reset, and close.
- Focused adapter contract tests cover IndexedDB validation and lazy upgrade, fenced device writes, browser coordination event normalization, HTTP result classification, and media event translation.
- Existing Editor Document validator and reducer tests remain because they define an independent domain value.
- Shallow save-queue, local-draft orchestration, unified-history orchestration, and shell-effect tests are removed only after equivalent external behavior is covered at the session seam.
- No Playwright dependency is added. Final verification includes a documented real-browser checklist for recovery, multi-tab takeover, degraded browser capabilities, proxy swaps, and playback.
- Every migration slice must pass the repository typecheck and test commands.

## Out of Scope

- Workflow Run lifecycle changes.
- Ingest Job lifecycle changes.
- Deepening server-side Clip Editor Document persistence.
- Postgres schema or migration changes.
- Changing editor HTTP route contracts.
- Collaborative or real-time multi-device editing.
- Operation-log or event-sourced editor history.
- Per-field conflict resolution.
- Moving export creation or Clip Render lifecycle into the session.
- Refreshing unrelated expiring brand or source presigned URLs.
- Adding Playwright or another end-to-end browser framework.

## Further Notes

- The existing Editor Document revision remains the cloud split-brain backstop even when browser coordination works normally.
- Browser persistence migration is local and lazy; it must never delete an unreadable legacy record merely because the new parser cannot upgrade it.
- Structured diagnostics should identify the clip, session generation, document version, ownership generation, and typed outcome without logging document contents.
- Work proceeds in the dependency order declared by the local tickets. Each ticket is independently verifiable and keeps exactly one protocol owner.
