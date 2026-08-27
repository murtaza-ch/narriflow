# 05 — Make finalization replayable

**What to build:** Persist the creator's exact completion intent before calling the provider, reconcile ambiguous completion against exact object truth, and commit one Project and Ingest Job even when the browser or web process loses the response.

**Blocked by:** [02 — Converge interrupted upload admission](02-converge-interrupted-upload-admission.md); [03 — Route small media through direct PUT](03-route-small-media-through-direct-put.md).

**Status:** ready-for-agent

**Specification:** [Deepen Upload Session intake and reconciliation](../spec.md)

## Observable acceptance criteria

- [ ] Finalize validates and durably records the exact ordered multipart ETag inventory, or the single-PUT completion intent, before any irreversible provider completion call.
- [ ] Frozen title, brand snapshot, language, and Content Pack settings already owned by the session remain the only inputs used by replay or background reconciliation.
- [ ] The first accepted finalize moves `uploading` to `finalizing` with a compare-and-set guard. Concurrent finalize requests adopt that intent and cannot replace it.
- [ ] A successful provider completion performs one exact object probe and requires declared byte length before handoff.
- [ ] Provider timeout, connection loss, retryable response, and lost application response are classified as ambiguous and move the session to `reconciling`, not `failed`.
- [ ] Exact NoSuchUpload probes the exact object. A present valid object is adopted; an absent object follows the persisted retry or terminal decision.
- [ ] Bucket absence, permission denial, invalid parts, malformed inventory, and size mismatch retain distinct stable dispositions.
- [ ] Request handling performs at most one short inline reconciliation attempt, then returns a typed `reconciling` outcome with Retry-After guidance and the same session ID.
- [ ] A `reconciling` outcome uses HTTP 202 and is not rendered as an upload failure or permission to start fresh.
- [ ] The handoff transaction creates the preallocated Project, one Content Pack, one Upload Finalize Ingest Job uniquely linked to the session, the verified source facts, and one queued lifecycle outbox event, then settles the session `queued_for_ingest`.
- [ ] Replaying after the handoff returns the same Project and Ingest Job without another provider operation or database child row.
- [ ] Verified size and content type flow into the Ingest Job so its normal upload-finalize path does not repeat HeadObject.
- [ ] Event dispatch failure after commit cannot reverse the valid session or ingest handoff; the durable outbox remains retryable.
- [ ] Once finalization intent is accepted, user Discard is rejected as unsafe while system reconciliation continues.
- [ ] Structured diagnostics describe state, provider operation class, disposition, duration, and replay without provider IDs, keys, ETags, settings, URLs, or raw errors.

## Public-interface and failure-injection tests

- [ ] Failure injection runs before and after intent persistence, provider completion, exact probe, handoff transaction, outbox append, response delivery, and terminal settlement.
- [ ] Interface tests cover single and multipart success, repeated finalize, concurrent finalize, timeout before and after object creation, exact NoSuchUpload, invalid parts, size mismatch, database failure after provider success, and completed replay.
- [ ] Disposable PostgreSQL tests prove finalization fencing, stale writer rejection, exactly-one Project, Content Pack, Ingest Job and event, transaction rollback, and deterministic replay.
- [ ] A stale inline reconciler may finish a provider call but cannot overwrite a later settlement.
- [ ] Cost tests prove normal single and multipart finalization use one exact object probe and no provider inventory call.
- [ ] Ingest contract tests prove the verified metadata is consumed without a duplicate HeadObject while media probing and duration authority remain unchanged.
- [ ] Hono tests prove 200 completed, 202 reconciling, typed permanent errors, Retry-After, and message-independent mapping.

## Migration and recovery constraints

- [ ] Completion inventory is versioned, size-bounded, parsed through shared validation, and never read through unchecked persistence casts.
- [ ] Add the database uniqueness needed to link one Ingest Job to one Upload Session before enabling replayable handoff.
- [ ] Do not create compatibility reads for finalization payloads written by the old pre-production path.

## Scope boundaries

- [ ] Do not build the recurring worker sweep, expiry maintenance, final Pause or Discard UI, or a generic distributed transaction framework.
- [ ] Do not move media duration, quota charging, normalization, or Workflow Run admission into Upload Session.

## Fresh-task handoff

Implement after tickets 02 and 03 with `/implement`; use `/tdd` for every completion ambiguity and handoff transaction; finish with `/code-review`; run uncached module, database, Hono, ingest, typecheck, lint, and build checks.
