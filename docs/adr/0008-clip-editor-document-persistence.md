# Clip Editor Document Persistence owns canonical server mutation

Clip Editor Document Persistence is the deep server-side module for canonical document reads, typed post-creation mutations, revision fencing, immutable original capture, dependent database invalidation, and durable obsolete-media cleanup intent. Its interface reads one document, mutates one document with a typed intent, or mutates a bounded project selection with one coherent intent. Full replacement and Reset use caller revisions. Field intents apply to the latest canonical document through bounded compare-and-set retries.

The Clip table remains the storage projection. One codec applies current null defaults, rejects malformed non-null document values, and encodes validated JSON for Prisma. The shared validators module owns typed Clip Editor Document and normalized deleted-range equality after values cross that codec. Every real mutation increments the revision once, retires mutable Clip Render rows, and commits document columns, first-original capture, derived-state invalidation, and deduplicated Media Cleanup obligations in one transaction. Immutable Clip Exports remain unchanged. Media Cleanup owns exact-key deletion execution after commit; storage failure never reverses an accepted edit.

Studio Editing Session still owns working edits, history, Device Draft durability, Studio Write Ownership, cloud convergence, preview eligibility, and playback. Clip Composition Plan still owns preview and render geometry. HTTP routes and React remain adapters and do not choose revision, invalidation, or cleanup behavior.

## Considered options

We rejected keeping mutation planning in Clip Service because every route had to reproduce revision and invalidation rules; storing a second whole-document column because it would create two synchronized shapes; deleting objects inside the mutation transaction because object storage cannot participate atomically; post-response cleanup callbacks because a process crash loses the final object reference; an editor-specific cleanup executor because deletion policy applies to more than editor mutations; and retrying stale full replacements because that can overwrite newer work.

## Consequences

Presentation and project-selection intents can move behind the same interface without adding another persistence owner. Preview media retires only when the source window changes. Screen, Automatic, and Split evidence retires only when the source window or deleted ranges change. Transcript-only changes retain both classes of derived work. Clip Editor Document Persistence owns when an accepted edit creates Media Cleanup intent. Media Cleanup owns claim, renewal, deletion, retry, and settlement. Its diagnostics include stable origin, class, project, Clip, phase, outcome, attempt, and elapsed time but never document content, URLs, object keys, or provider bodies. Narriflow's pre-production policy means each moved mutation path removes its old implementation in the same change.

## Completion review — 2026-08-30

The direct cutover is complete. Studio Editing Session, Reset eligibility, Device Draft cleanup, cloud convergence, and persistence use the shared typed equality policy. Generic three-way draft merging and unrelated fingerprints retain their own contracts. Detected Clip replacement admits cleanup intent atomically in both Workflow Run lifecycle paths, and Clip duplication covers every destination with provisional Media Cleanup intent until the duplicate transaction adopts it.
