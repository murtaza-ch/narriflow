# Plan 039: Bind multipart uploads to authoritative bytes, type, and identity

> **Schema/provider migration**: This is the explicit follow-up required by
> Plan 034's STOP condition. Roll it out additively and preserve resume behavior
> for in-flight legacy sessions. Do not automatically retry an ambiguous
> multipart completion mutation.
>
> **Drift check**:
> `git diff --stat 05d273d..HEAD -- packages/validators/src/upload.ts packages/db/prisma/schema.prisma packages/db/prisma/migrations packages/services/src/project.service.ts packages/services/src/r2-storage.ts 'apps/web/app/(app)/upload' apps/worker/src packages/services/src/*.test.ts`

## Status

- **Priority**: P1 release blocker
- **Effort**: M
- **Risk**: MED
- **Confidence**: HIGH
- **Depends on**: plans/023-secure-and-bound-media-ingest.md,
  plans/034-resumable-upload-recovery.md, plans/041-production-shaped-integration-gates.md
- **Category**: security, storage, migration, reliability, UX
- **Planned at**: commit `05d273d`, 2026-07-10, live working tree

## Why this matters

The presign request accepts an independently client-supplied `fileSizeBytes`
and `partCount` (`packages/validators/src/upload.ts:21-29`). Initialization
persists only part count (`packages/services/src/project.service.ts:1391-1400`;
`packages/db/prisma/schema.prisma:293-305`). Completion reads actual R2 metadata
but queues ingest without comparing actual bytes/type to the authorization
(`project.service.ts:1476-1495`).

An authenticated caller can therefore claim a small file while requesting an
excessive number of signed parts, consume presign/database/storage resources,
and complete an object beyond the product's advertised 5 GB limit. Resume also
cannot prove that a selected file still matches the server-authorized object.

Cloudflare R2 references:

- <https://developers.cloudflare.com/r2/platform/limits/>
- <https://developers.cloudflare.com/r2/objects/upload-objects/>
- <https://developers.cloudflare.com/r2/api/s3/presigned-urls/>

## Target invariants

1. The server derives an allowed part size/count from authoritative expected
   bytes; the client never chooses an unrelated count.
2. Every upload session stores the expected filename, normalized MIME, bytes,
   part size/count, and a privacy-safe file fingerprint/version.
3. Resume, sign-more-parts, and completion all bind to that exact session
   identity and owner.
4. Completed object bytes and content type match the authorization and product
   limits before ingest can be queued.
5. Ambiguous provider completion remains reconciling; it never triggers an
   automatic second completion or new project.
6. Expired/abandoned multipart state and orphaned pending projects are swept
   according to an approved retention policy.

## Phase 1: Additive session contract

Add nullable rolling-deploy fields first:

- `expectedSizeBytes` as a 64-bit integer;
- `expectedMimeType`, normalized filename, fingerprint algorithm/version and
  fingerprint value;
- authoritative `partSizeBytes`, `partCount`, optional uploaded-byte count;
- object checksum/ETag metadata where R2 semantics are reliable;
- terminal/reconciliation timestamps and safe cleanup error/attempt fields.
- a tenant-scoped unique `initializationId` generated/persisted by the client
  before the first request, so a lost initialization response can return the
  already-created project/provider/session instead of creating duplicates.

Do not store raw local paths, browser-specific metadata, or a full-file hash
that forces reading 5 GB before upload. Define the fingerprint contract from
stable, privacy-minimized inputs and version it so it can evolve.

Backfill existing initiated sessions as `legacyUnbound`; they may resume only
under the current validated part-set path and must not be treated as strongly
bound. Set a short documented sunset for legacy sessions.

## Phase 2: Server-derived multipart authorization

- Accept expected bytes/MIME/name/fingerprint, validate plan/user quotas, and
  derive part size/count server-side within R2 limits.
- Require a stable initialization ID for fresh requests. Create-or-read its
  unique winner transactionally and compensate a provider multipart upload if
  the database session cannot be established. The client stores the ID before
  `fetch`, reuses it after response loss, and clears it only after a confirmed
  terminal outcome.
- Cap the number of URLs returned per request. For very large uploads, issue
  bounded pages of part URLs against the same session instead of materializing
  up to 10,000 signatures at once.
- Record metadata before provider initialization or compensate deterministically
  if provider creation succeeds and the DB write fails.
- Put expected size/type/session identifiers in provider object metadata where
  supported, but keep the database authoritative.
- Bind all resume/part-list/sign calls to project, provider upload ID, storage
  key, owner, unexpired state, fingerprint, and expected metadata.

Client code may calculate part boundaries from the server response, but must
not be able to raise the count or change bytes/type after initialization.

## Phase 3: Completion and ingest gate

1. Preserve Plan 034's exact unique `1..partCount` completion validation.
2. Complete once, then HEAD/reconcile the object.
3. Compare actual object size against `expectedSizeBytes` exactly and against
   the absolute 5 GB/product-plan limit. Treat missing/invalid size as
   reconciliation-required, not success.
4. Validate content type against the authorized normalized type and perform the
   existing media sniff/probe before ingest. Client/R2 MIME alone is not proof.
5. If metadata mismatches, do not queue ingest. Mark the session/project with a
   stable non-sensitive failure or reconciling state, retain enough evidence for
   cleanup/support, and prevent download/public use.
6. Transition session completion, project source metadata, and ingest admission
   atomically after authoritative validation.

## Phase 4: Abandoned state lifecycle

After Plan 030's retention/deletion policy is approved:

- sweep expired initiated multipart uploads in bounded batches;
- abort provider multipart uploads idempotently;
- remove only objects proven to belong to the expired uncompleted session;
- transition/delete orphaned `uploading` projects with an auditable reason;
- expose retryable cleanup failures to operators without raw provider secrets;
- publish metrics for created/completed/aborted/expired/reconciled sessions,
  expected versus actual bytes, and presign fan-out.

## UX and API behavior

- Return server-derived part size/count and versioned session fingerprint.
- Resume copy distinguishes “same file can continue,” “upload expired—start
  again,” and “completion is being reconciled—do not re-upload.”
- Show uploaded bytes/parts from authoritative server/provider state, not only
  optimistic client progress.
- Map size/type mismatch to stable user copy and support diagnostics; never
  expose storage keys/upload IDs unnecessarily.

## Test plan

- Unit/property: part derivation at 1 byte, minimum part boundary, exact 5 GB,
  one byte over limit, maximum part count, invalid/overflow numeric inputs.
- Integration with real Postgres and an R2-compatible emulator/test bucket:
  initialization compensation, owner isolation, paged signing, resume metadata,
  exact completion, mismatch, missing HEAD metadata, provider ambiguity.
- Concurrency: duplicate initialization/idempotency, two completion calls, sign
  after expiry, lost/invalid initialization response, provider-created/DB-failed
  compensation, completion versus sweeper.
- Security: tiny claimed size + huge count, changed MIME/name/fingerprint,
  cross-project IDs, extra/duplicate/out-of-range parts.
- Lifecycle: abort retry, orphan cleanup, legacy session sunset.
- Full release gates plus a browser resume/reconcile flow at small and multipart
  fixture sizes.

## Done criteria

- [ ] Client cannot independently choose part count.
- [ ] Session persists expected bytes, type, file identity, and authoritative
  multipart geometry.
- [ ] Actual bytes/type are verified before ingest is queued.
- [ ] Over-limit or mismatched objects never become usable project sources.
- [ ] Presign work is bounded per request/session/user.
- [ ] Legacy and ambiguous completion behavior cannot create duplicate projects.
- [ ] A lost fresh-initialization response cannot create a duplicate project or
  multipart upload on retry.
- [ ] Abandoned multipart/project cleanup has approved retention and observable
  idempotent behavior.

## STOP conditions

- R2/test infrastructure cannot provide authoritative object size or a safe
  ambiguity-reconciliation path.
- A rollout would invalidate active Plan 034 resume records without a compatible
  legacy path.
- The fingerprint design stores sensitive local paths or requires full-file
  hashing before upload without an approved UX tradeoff.
- Cleanup/deletion policy from Plan 030 is undecided.
- The implementation automatically retries multipart completion after a
  transport-ambiguous result.
