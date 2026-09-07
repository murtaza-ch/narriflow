# 02 — Converge interrupted upload admission

**What to build:** Make every interrupted start converge on one provider upload or a clean terminal session. A creator who loses the first response can retry the same client intent without creating duplicate storage state, while admission failures compensate any provider work they can identify.

**Blocked by:** [01 — Establish the Upload Session tracer and cut over multipart intake](01-establish-upload-session-tracer.md).

**Status:** completed

**Specification:** [Deepen Upload Session intake and reconciliation](../spec.md)

## Observable acceptance criteria

- [x] `initiating` is a durable, recoverable state rather than a transient gap between database and provider calls.
- [x] The storage adapter can list unfinished multipart uploads for one exact session-unique object key, follow pagination, and return bounded opaque identifiers plus initiation facts.
- [x] If provider creation succeeds but binding its opaque ID is lost, the next open or reconciliation attempt adopts the one exact-key upload instead of creating another.
- [x] If several unfinished uploads exist for the exact session key, the module adopts one deterministic candidate and aborts every extra candidate.
- [x] Exact-key discovery never searches a workspace root, unrelated prefix, or whole bucket and never adopts an object created for another session.
- [x] A replay that finds a bound active provider upload performs no unfinished-upload listing and no new provider initiation.
- [x] Database failure, provider refusal, malformed provider identity, or admission cancellation moves the session into typed compensation or failure instead of leaving it indefinitely `initiating`.
- [x] Compensation aborts known multipart state, treats an already missing upload as success, records retryable cleanup failure, and never creates or deletes a Project.
- [x] Quota and brand resolution run only for the winning fresh admission, not for retries of the same durable reservation.
- [x] Stable diagnostics distinguish reservation, provider creation, bind, adoption, duplicate abort, and compensation without logging keys, provider IDs, or raw errors.

## Public-interface and failure-injection tests

- [x] Failure injection covers before and after reservation, provider creation, provider response, provider binding, response delivery, adoption, duplicate abort, and terminal state persistence.
- [x] Interface tests cover zero, one, and several exact-key unfinished uploads plus transient listing failure, permission failure, bucket absence, and malformed provider results.
- [x] A lost-response test proves repeated open commands return the same Narriflow session and exactly one adopted provider upload.
- [x] Concurrent recovery tests prove only one claimant binds provider state and stale claimants cannot replace it.
- [x] Storage contract tests prove exact-key filtering, pagination, opaque identifiers, already-missing abort behavior, and cleanup of every isolated fixture.
- [x] Operation-count tests prove the normal bound-session path performs no provider listing and the ambiguous start path performs only the probes needed to decide it.

## Migration and recovery constraints

- [x] Any reconciliation claim fields needed by admission recovery are additive to the new session shape and remain internal to Upload Session.
- [x] Provider lifecycle cleanup is documented as a backstop for the last unobservable process-crash gap, not the normal admission recovery mechanism.
- [x] Re-running recovery after partial duplicate cleanup is idempotent.

## Scope boundaries

- [x] Do not add small-file PUT, finalization reconciliation, the worker sweep, user-facing Discard, or bucket-wide orphan collection.
- [x] Do not expose unfinished-upload listing through Hono or the browser.

## Completion evidence

- Expired admission leases use a fenced PostgreSQL compare-and-set claim. Concurrent recovery elects one claimant; stale writes cannot replace it, and a losing provider transfer is discovered and aborted without exposing provider identity.
- Recovery adopts the deterministic exact-key candidate, retries partial duplicate cleanup durably, terminalizes malformed provider identities, and distinguishes missing, denied, invalid, and unavailable storage probes. Exact-key R2 inventory follows pagination and abort treats an already-missing transfer as success.
- Failure-injection, operation-count, HTTP, live R2, and fresh 53-migration PostgreSQL tests pass. Independent specification review found no remaining actionable gaps, and standards review found no hard violations.

## Fresh-task handoff

Implement after ticket 01 with `/implement`; use `/tdd` for every start failure window and concurrent adoption; finish with `/code-review`; run uncached module, database, and isolated storage contracts plus typecheck, lint, and build.
