# 02 — Keep Clips retryable when storage deletion is incomplete

**What to build:** Make user-requested Clip deletion fail closed. Narriflow must attempt every referenced preview, render, and dub deletion, preserve the Clip when any genuine storage failure remains, and return one safe retryable outcome so the user can try again without losing the recovery inventory.

**Blocked by:** None — can start immediately.

**Status:** done

**Specification:** [Close the remaining architecture findings](../spec.md)

- [x] Clip deletion enumerates and deduplicates every referenced preview, render, dub-audio, and dub-video object before changing the Clip row.
- [x] Every enumerated object is attempted even when another deletion fails.
- [x] An already-missing object counts as successful deletion so retries converge after partial progress.
- [x] Any genuine storage failure preserves the Clip row and its media inventory and returns a stable retryable storage-incomplete failure.
- [x] A second deletion attempt after partial success accepts the already-missing objects and deletes the Clip once every remaining object succeeds.
- [x] A database-row deletion failure after storage success leaves the Clip retryable; a later attempt treats the removed objects as already complete.
- [x] Existing missing, forbidden, and active-publication admission behavior remains unchanged.
- [x] Authenticated Request Policy adapters translate the storage-incomplete outcome without exposing provider messages, object keys, signed URLs, or stack details.
- [x] The user-facing deletion action preserves its current success behavior and presents a bounded retry instruction for storage-incomplete failure.
- [x] Synchronous Clip deletion does not enqueue deferred cleanup and then report success; the Clip row itself remains the recovery owner until deletion completes.
- [x] Public-interface tests cover full success, one and multiple storage failures, mixed success and missing objects, partial-progress retry, database deletion failure, ownership denial, and active publication.
- [x] Failure tests assert that every key is attempted and that no genuine partial failure reaches the Clip-row deletion operation.
- [x] Focused service, request-adapter, and user-action tests plus repository typecheck, lint, and fast aggregate tests pass.
