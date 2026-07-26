# Plan 034: Recover stale resumable uploads without trapping or duplicating users

> **Executor instructions**: Work in the shared current tree, preserve all
> user/concurrent changes, and touch only scoped files. Do not stage, commit,
> push, or edit this plan/index.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plan 023
- **Category**: reliability, ux, data lifecycle
- **Planned at**: commit `05d273d`, 2026-07-09, live working tree
- **Result**: DONE — reviewed through three independent passes 2026-07-10;
  authoritative multipart-part validation, fail-closed provider classification,
  and deterministic server reconciliation landed. The final aggregate passed
  233 tests plus lint, typecheck, audit, build, and diff checks.

## Why this matters

Before this plan, the upload client stored one resume record forever without
`expiresAt`. If the
server session expires, completes after a lost response, or its R2 multipart ID
disappears, re-selecting the same file keeps resubmitting the stale IDs and can
never recover. Resume also trusted the stored IDs more than the current request;
the server did not distinguish “completed already” from “resume is gone” with
a stable response.

## Scope

- `apps/web/app/(app)/upload/_components/upload-shell.tsx`
- `apps/web/app/api/[[...route]]/route.ts`
- `packages/services/src/project.service.ts`
- `packages/services/src/index.ts`
- `packages/validators/src/error-messages.ts`
- matching colocated/unit tests created only for pure resume helpers

No schema/migration, automatic R2 deletion, or background abandoned-session
sweep in this pass.

## Steps

1. Version and validate the local resume payload. Persist `expiresAt`, validate
   every field and the exact current file fingerprint, clear corrupt/legacy/
   other-file data, and never let localStorage exceptions block a fresh
   upload. Retain exact-file expired IDs until the server authoritatively
   reconciles them; a client clock must never create a duplicate project.
2. Give resume lookup explicit service outcomes:
   - active + matching file name/part count → return uploaded parts;
   - completed → return the existing project as already finalized;
   - expired/missing/provider upload gone/mismatched, with the exact object
     definitely absent → a stable `upload_session_unavailable` response;
   - ambiguous provider state or a missing multipart with an existing object →
     `upload_completion_reconciliation_required`, never a fresh mutation.
   Do not expose provider IDs or raw provider errors.
3. On `upload_session_unavailable`, clear the stale client record and make one
   explicit fresh initialization attempt. Surface a small informational toast.
   Do not retry network ambiguity or any completion mutation automatically. On
   already-completed, clear the record and navigate to that project instead of
   creating a duplicate.
4. Validate the final response before slicing/uploading: same part count,
   complete unique part-number range, and valid URLs/ETags for every expected
   pending/completed part. Before provider completion, independently validate
   the exact authoritative server part set against `UploadSession.partCount`.
   Clear the local record only after a confirmed final outcome.
5. Add pure tests for legacy/corrupt/expired/other-file records, client-clock
   skew, the server reconciliation matrix, provider ambiguity, and missing/
   duplicate/extra/out-of-range completion parts. Run scoped Biome plus full
   typecheck/tests/build.

## Done criteria

- [x] An expired local resume record cannot brick re-selection of the same file.
- [x] A lost completion response cannot create a second upload/project on retry.
- [x] Network ambiguity never triggers an automatic mutating retry.
- [x] Client/server resume metadata is validated before uploading any part.
- [x] User-facing recovery copy is stable and actionable.

## STOP conditions

- Correct file-size/MIME binding requires adding session columns; record that
  as the follow-up migration rather than guessing.
- R2 cannot distinguish a completed upload from a missing upload safely.
- A solution retries `/uploads/complete` automatically after an ambiguous
  transport failure.

## Follow-up migration

Persist expected file size, MIME, file name/fingerprint, uploaded byte count,
and an object-integrity/checksum signal on `UploadSession`; add an abandoned
multipart sweeper and project cleanup only after Plan 030 retention approval.
