# External review — codex (gpt-5.6-sol, high) + Fable

Two independent reviews of the July 2026 audit work, run after it landed.
codex reviewed correctness/optimization read-only; Fable reviewed UI/UX.

## Confirmed correct (do not re-litigate)

codex verified these against the source and found no defect:

- The ffmpeg duration fix — output `-t` is in the output-option section,
  `-shortest` stays compatible, and multi-cutaway chaining shifts the
  logo/music input indices correctly.
- The padded-window and `previewStartSec` mapping, for an unchanged clip.
- `JSON.stringify` as the render-invalidation comparison — sound because both
  values are canonicalized through the same Zod object schema. The primitive
  B-roll comparison is equivalent.
- `Buffer.allocUnsafe` in `readFilePart` — no uninitialized bytes leak, since
  only the filled prefix is returned.
- 16 MB multipart part size — 5 GiB is 320 parts, far under the 10,000 limit,
  and 16 MB clears R2's 5 MB minimum.

## Fixed in response

| Finding | Where |
| --- | --- |
| Losing worker deleted the winning worker's preview object | `clip-preview.ts` — attempt-unique keys |
| Previews blocked the I/O mutex and starved social publishing | `index.ts` — own poll loop |
| No ffmpeg process timeout; stalled read could hang the loop | `clip-preview.ts` — timeout + `-rw_timeout` |
| Failing top-N clips poisoned the preview queue forever | `clip-preview.ts` — in-process backoff |
| Buffering treated the symptom; checksum config is the cause | `r2-storage.ts` — `requestChecksumCalculation` |
| Short read returned a truncated buffer under the declared length | `r2-storage.ts` — `ShortReadError` |
| `nb_frames <= 1` misread a still-image video as cover art | `clip-preview.ts` |
| Caption preview weight (900/600) didn't match burn-in | `caption-style-engine.tsx` — 700/400 |
| "Preview generating…" never resolved without a reload | `hasPreview` + studio polling |
| Studio error state failed AA contrast in light mode | `studio.danger`, 6.14:1 |
| Activity showed raw stage ids, oldest-first, overpromised | `project-events.tsx` |
| Delete copy omitted scheduled social posts | `delete-project-button.tsx` |

## Deferred — real, and each needs a schema change

These are genuine defects. They were **not** fixed because each needs a
migration plus real design, and a half-implementation would be worse than the
current known state. Roughly descending severity.

### 1. Claims have no lease/attempt ownership

`reapStuckWorkflowRuns` selects stale runs by `updatedAt` but its conditional
update only rechecks `id + status`, so a heartbeat landing between the two is
ignored. Worse, the failure and completion paths update by id without checking
which attempt they belong to — so a reaped worker that finishes later can
requeue or complete a *newer* attempt.

Ingest is deterministically exposed: it is reaped from `startedAt` after 30
minutes while legitimate downloads are allowed 45–60, and there is no ingest
heartbeat at all.

**Fix**: an attempt/lease token returned by the claim and required on
heartbeat, completion, failure and reaping, plus `leaseExpiresAt`. Add ingest
heartbeats. Minimum viable stopgap: repeat the stale timestamp in each reaper's
conditional update.

### 2. `deleteProject` is TOCTOU-unsafe

Keys are snapshotted, storage deletion runs outside any lock, then the row is
deleted. Only `WorkflowRun` is checked — an active ingest, an in-flight
multipart upload, preview generation, or a workflow queued *after* the snapshot
can all write objects between enumeration and cascade delete, orphaning them.
Storage-first ordering only guarantees that failures for the *snapshotted* keys
block the DB delete; it does not make deletion race-safe.

**Fix**: atomically move the project to a `deleting` state that every enqueue,
claim and upload path rejects, then enumerate and delete, then remove the row.
Persist the cleanup work so it can be retried rather than relying on one long
unlocked interval.

### 3. Render invalidation still races

The change comparisons happen before the transaction, so two identical
concurrent autosaves can both observe the old value and both invalidate. More
seriously, R2 deletion happens *after* the transaction while render outputs
reuse a deterministic clip/aspect key — a new render can upload that key before
the delayed stale delete lands, leaving a completed row pointing at a deleted
object. Deleting a `ClipRender` row also breaks an already-running worker's
completion path.

**Fix**: immutable generation-scoped storage keys, an optimistic edit version,
and cancelling/marking stale rows rather than deleting rows a worker still
holds. Worker completion should CAS on the generation and delete its own upload
if it lost ownership.

### 4. Boundary edits can leave a preview covering the wrong range

Proxies carry only ~4s of padding, but `updateClipBoundaries` neither checks nor
clears preview metadata. Move a boundary far enough and the card/studio seek
outside the proxy. Retention may later delete the source, making repair
impossible.

**Fix**: keep the proxy only when the new effective interval lies inside
`[previewStartSec, previewStartSec + previewDurationSec]`; otherwise clear the
metadata, delete the proxy and enqueue regeneration.

### 5. Source purge can starve eligible rows

The candidate query takes an arbitrary 200 ready projects with no cutoff filter
and no ordering, so a stable first page of recent/ineligible projects can stop
older eligible ones from ever being examined. Eligibility is also snapshotted
before the delete, so a source-dependent workflow queued in between is not
protected by conditioning on the storage key alone.

**Fix**: filter on `ingestCompletedAt < cutoff`, order ascending, and claim a
source for purge atomically before deleting it.

### 6. Unknown error codes default to retryable

`TRANSIENT_FAILURE_CODES` is informational; the decision function retries
anything not on the permanent denylist. Ingest explicitly declines to retry a
non-transient HTTP response and throws `remote_media_download_failed`, which is
absent from the permanent set and so gets three outer attempts — potentially
three hour-long ingests. Bounded, so not an infinite poison job, but wasteful.

**Fix**: decide retryability at the error boundary, or switch to the transient
allowlist. Unknown codes should alert and fail, or get at most one conservative
retry.

## Also open (non-architectural)

- Orphaned preview objects if a process dies between upload and claim — needs a
  sweeper that diffs the previews prefix against `Clip.previewStorageKey`.
- Preview failure backoff is in-process only; a durable version needs
  `attempts` / `nextAttemptAt` / terminal-error columns on `Clip`.
- Audiogram previews use the default waveform colour because
  `getClipsNeedingPreview` doesn't select `captionPreset`.
- Clip cards use native `<video controls>`, so scrubbing past the clip boundary
  snaps back; competitors ship a custom minimal transport for this reason.
- The Chakra/Emotion SSR hydration mismatch remains live.
