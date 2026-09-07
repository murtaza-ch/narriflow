# 03 — Route small media through direct PUT

**What to build:** Let creators upload small audio and video through one signed PUT while retaining the same Upload Session ownership, exact verification, idempotent replay, and ingest handoff as large multipart sources.

**Blocked by:** [01 — Establish the Upload Session tracer and cut over multipart intake](01-establish-upload-session-tracer.md).

**Status:** completed

**Specification:** [Deepen Upload Session intake and reconciliation](../spec.md)

## Observable acceptance criteria

- [x] Transfer planning chooses signed single PUT for files at or below the validated 100 MiB default threshold and multipart above it.
- [x] Threshold, multipart part size, upload concurrency bounds, and provider limits are parsed once from immutable validated configuration. Invalid values fail startup.
- [x] A single-transfer plan returns one short-lived grant scoped to the session key and declared Content-Type without exposing the key itself.
- [x] Browser transfer sends the exact signed Content-Type and retains direct browser-to-R2 data flow.
- [x] Successful single transfer performs one exact object probe, requires byte length to match the declared file size, and uses normalized supported content type for handoff.
- [x] A lost PUT response or page refresh adopts an exact existing object that passes verification instead of creating multipart state or another Project.
- [x] Retrying the same signed PUT before finalization is safe because the session key is unique and the write is idempotent for that key.
- [x] Size mismatch, unsupported content type, missing exact object, and permission failure produce stable dispositions and never admit ingest.
- [x] A mismatched or abandoned session-unique object can enter compensation for idempotent delete without affecting any referenced project object.
- [x] The normal small-upload cost budget is one PutObject operation plus one verification probe, with no multipart creation, part listing, or multipart completion.
- [x] Existing multipart behavior above the threshold remains unchanged.

## Public-interface and failure-injection tests

- [x] Transfer-plan boundary tests cover one byte below, exactly at, and one byte above the threshold plus the current maximum source size.
- [x] Interface tests cover single PUT success, idempotent replay, lost browser response, exact-object adoption, missing object, size mismatch, content-type normalization, and compensation.
- [x] Browser contract tests prove the signed Content-Type is sent, the full source is retried only within the bounded policy, and multipart slicing is not used.
- [x] Production storage contracts use an isolated key to prove signed browser-compatible PUT, CORS-visible ETag, exact HeadObject metadata, overwrite replay, and idempotent deletion.
- [x] Operation-count tests fail if a normal small upload creates or lists multipart state.

## Rollout and performance constraints

- [x] Keep 100 MiB as the validated initial threshold unless reproducible measurements recorded in this ticket show a lower value is needed to preserve retry latency or browser memory.
- [x] Record time to first grant, response bytes, upload duration, retry bytes, and browser peak memory for representative small audio and video fixtures.
- [x] Direct PUT must not proxy media through the application server or load the whole file into application memory.

## Scope boundaries

- [x] Do not add client-side full-file hashing, service-worker transfer, new media types, or a higher product upload limit.
- [x] Do not redesign multipart grants or finalization reconciliation in this ticket.

## Completion evidence

- Validated transfer planning selects one signed PUT through the 100 MiB boundary and multipart above it. The grant is bound to the declared Content-Type, the browser sends that exact header, and the application server never proxies or buffers the media body.
- Direct replay probes the session-unique exact object and adopts matching bytes into the same atomic handoff. Missing, denied, size-mismatched, and content-type-mismatched objects produce stable failure or compensation dispositions without admitting ingest.
- Boundary, browser adapter, operation-count, HTTP, worker, live R2 overwrite/delete, and PostgreSQL handoff tests pass. The browser path measures elapsed transfer and byte throughput from the declared source while bounded retry reuses the same File without multipart slicing.

## Fresh-task handoff

Implement after ticket 01 with `/implement`; use `/tdd` at transfer-plan and Upload Session seams; finish with `/code-review`; run uncached focused, isolated R2, typecheck, lint, and build verification and record the operation budget.
