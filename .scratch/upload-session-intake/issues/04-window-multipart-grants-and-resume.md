# 04 — Window multipart grants and make resume byte-accurate

**What to build:** Give large uploads short-lived grants only as they are needed, refresh them before expiry, resume from exact provider parts after interruption, and show progress based on bytes rather than completed-part count.

**Blocked by:** [03 — Route small media through direct PUT](03-route-small-media-through-direct-put.md).

**Status:** ready-for-agent

**Specification:** [Deepen Upload Session intake and reconciliation](../spec.md)

## Observable acceptance criteria

- [ ] Multipart planning uses the validated 16 MiB default part size, increases it when provider limits require, and produces uniform non-final parts with no more than 10,000 parts.
- [ ] The grant command accepts only the Narriflow session ID and a bounded set of in-range part numbers, then returns at most 16 short-lived grants by default.
- [ ] Grants default to 15 minutes, are issued only while the session permits transfer, and never include provider identity or storage key in durable browser state.
- [ ] The browser keeps at most the configured four part transfers active and requests the next grant window before current grants expire.
- [ ] An opaque cross-origin failure near grant expiry triggers one fresh grant path before the ordinary transient retry budget is exhausted.
- [ ] Part retries remain bounded at three attempts with exponential backoff and jitter. Permanent input or authorization failures do not retry.
- [ ] The normal uninterrupted path uses its in-memory ETags and performs no ListParts call.
- [ ] A true resume lists provider parts through the module, follows pagination, validates unique in-range ETags, and returns fresh grants only for missing parts.
- [ ] Re-uploading a part number safely replaces that provider part and the final in-memory ETag inventory contains one value per expected part.
- [ ] Progress aggregates transferred bytes across active requests, includes already stored bytes, treats the smaller last part exactly, and reports stable speed and ETA facts.
- [ ] Pause aborts active browser transfers after their promises settle, retains the durable Upload Session, and does not call provider abort or clear the resume record.
- [ ] Resume with the exact file continues from stored provider parts. A different file cannot attach to the session even when its name matches.
- [ ] Browser storage retains only current-version Narriflow identifiers, exact file fingerprint, and safe display facts. Signed URLs and ETags stay in memory.

## Public-interface and failure-injection tests

- [ ] Planner tests cover size and count boundaries, uniform parts, final-part size, the 5 MiB provider minimum, and the 10,000-part maximum.
- [ ] Grant tests cover out-of-range, duplicate, excessive, expired, finalizing, completed, forbidden, and workspace-mismatched requests.
- [ ] Browser-adapter tests prove concurrency bounds, byte progress, ETA updates, backoff jitter, proactive refresh, opaque expiry recovery, pause, exact resume, and terminal error behavior.
- [ ] Resume tests cover empty, partial, complete, paginated, duplicate, malformed, and missing provider inventories plus transient and permanent probe errors.
- [ ] Operation-count tests prove no ListParts on normal transfer and exactly the documented inventory calls on resume.
- [ ] Performance fixtures record first-grant latency, grant response bytes, throughput, retry bytes, and browser peak memory for medium, 1 GiB, and 5 GiB sources.

## UX and compatibility constraints

- [ ] Keep the existing upload size and supported media contract.
- [ ] The upload meter remains accessible and uses the repository formatting helpers for speed and ETA display.
- [ ] This ticket may label the action Pause, but server-side Discard and post-finalization Verifying behavior belong to ticket 07.
- [ ] Remove the old all-parts-at-once response after the windowed path passes. Do not retain a fallback response shape.

## Scope boundaries

- [ ] Do not add adaptive unbounded concurrency, temporary provider credentials, background tab transfer, or multi-device resume.
- [ ] Do not call ListParts as routine progress polling.

## Fresh-task handoff

Implement after ticket 03 with `/implement`; drive transfer planning, grants, and the browser adapter with `/tdd`; finish with `/code-review`; run uncached focused, performance, typecheck, lint, and build checks.
