# 02 Data lifecycle and queries

**What to build:** Deleting data works and removes everything; hot reads stop overfetching; the schema enforces what the code assumes.

**Blocked by:** None

**Status:** done

Sole owner of `packages/db/prisma/schema.prisma` and migrations. Use one migration, `20261105000000_production_readiness`. Validate it on the local test database only; never apply it to Neon.

Also owns: `project.service.ts` deletion and list code, `project-retention-execution.ts`, `workspace-library.service.ts`, `clip.service.ts` list code, `visual-asset.service.ts`, `apps/api/src/domains/session/**`, `workflow.service.ts`.

## Must fix
1. **Deleting or purging a published or reviewed Project fails after media is gone (critical).** RESTRICT FKs at `schema.prisma:2092,2093,2962,2963,3013,3030` make `DELETE Project` throw: `ReviewRoundItem` clip and export, `ProviderReceipt` attempt, `PublicationAnalyticsIntent`, `PublicationManualDecision`. `project.service.ts:783` deletes storage first, then fails on every retry. `project-retention-execution.ts:91` loops the same way. Change to Cascade (NO ACTION was tested and still fails). Run a preflight or the row delete before irreversible storage work. Add a DB test with those children.
2. **Permanent delete orphans R2 objects (high).** `project.service.ts:686` omits `SourceAudio.storageKey`, `ExportBundle.storageKey` and execution artifacts, which retention does collect (`project-retention-execution.ts:66-69`). Best fix: user delete sets `purgeStartedAt` and reuses the retention pipeline. Also block on a running IngestJob and re-check guards inside the transaction (guards currently run outside it, `project.service.ts:709-766`).
3. **Retention purge wedges on upload that never pinned (high).** `project-retention-execution.ts:73-75` throws `project_retention_key_provenance_missing` for any `sourceStorageKey` with no obligation. In the `artifacts` phase also admit an `upload_source` obligation for a non-execution `sourceStorageKey`. Add a DB test.
4. **Missing indexes (high/medium).** `ContentPack @@index([projectId, createdAt(sort: Desc), id])` (seq scan at `project.service.ts:2180`, `ingest-job-lifecycle.ts:877,928`). Also `IngestJob.generationRunId`, `SocialPublicationAttempt.frozenStateId`, `AssistedCopyGeneration.clipId`, `ThumbnailFrameOperation.clipId`, `GeneratedMediaJob.clipId`, `ReviewRoundItem.clipId`, `ReviewComment.itemId`, `ReviewDecision.itemId`, `WorkflowRun.contentPackId`.
5. **Clip list loads every frozen export render (high).** `clip.service.ts:930-938`, filtered at `:286`. Use `renders: { where: { exportVariantId: null }, select }` and an explicit clip `select`. Confirm callers do not need the dropped fields.
6. **Folder counts scan every tenant (medium).** `workspace-library.service.ts:514-523,462`. Use `project.groupBy` filtered by `workspaceId`.
7. **Workflow history reads all events, then trims (medium).** `project.service.ts:916-917`, `workflow.service.ts:35`. Query newest 200 with `select`, then reverse.
8. **`listProjects` overfetches (medium).** `workspace-library.service.ts:317,354`. Explicit `select`; skip status counts when the caller does not need them (`/home`).
9. **Bootstrap redundancy (medium).** `apps/api/src/domains/session/routes.ts:74-83`, `projection.ts:36-40`, `processing-usage.ts:807`. Presign from already-listed keys and add a pre-authorised usage summary. Expected 14 to about 8 SQL statements. Correct the false "one round trip" comments at `packages/auth/src/identity.ts:392,427`.
10. **Visual asset delete loads a workspace's clip JSON in a transaction (medium).** `visual-asset.service.ts:440`. Push the reference check into SQL.
11. **Duplicate-invite invariant is code-only (low).** `workspace.service.ts:536`. Partial unique on `(workspaceId, lower(email))` where `acceptedAt` and `revokedAt` are null, and make revoke-then-create transactional.
12. **Retention bug (low).** `analyticsPublishedAt` is never written, so dubbing failure events never expire (`execution-retention-pages.ts:27`, `dubbing-execution.ts:250`).
13. **Dead columns and redundant indexes (low).** `schema.prisma`. Verify zero references first. Polling-era `WorkflowEvent` delivery fields and their two indexes, `Clip.autoLayoutAttemptCount` and lease fields, `CompletionCallback.nextObservationAt`. Redundant: `User_clerkId`, `WorkflowEvent_projectId_seq`, `ClipRender_clipId`, `SocialPost_socialAccountId`, `ProjectDeletionReceipt_deleteAfter`, `FrozenPublicationState_clipExportVariantId`, `TrackedVideo_socialPostId`, `WorkspaceEvent_createdAt`.
14. **Schema drift (low).** `schema.prisma:888-891` and `prisma migrate diff` would drop 10 raw indexes including HNSW and change 6 FKs. Model what Prisma can express and correct the false comment. Add a diff allowlist check if it stays small.
15. **CHECK constraints on lifecycle columns (low-medium).** At least `WorkflowRun.status`, `.stage`, `ReviewRound.status`, `GenerationFinishing.state`, `CampaignOperation.status`, `NotificationLedger.status`. Derive allowed values from the code, not guesses.

## Verification
Run `test:workflow:db`, `test:execution:db`, `test:clip-editor-persistence:db`, `test:brand-profiles:db`, `test:social-publication:db`, `test:vizard-expansion:db`, and any retention suite. `bun run --cwd packages/db prisma:generate` after schema changes.

## Comments

### 2026-11-04, implementation

Migration: `20261105000000_production_readiness`, validated only on the local test database. Generated list updated (`apps/api/src/generated/database-migrations.json`).

**Findings confirmed and fixed**

1. Delete and purge blocked. Confirmed, and wider than filed. A catalog walk from `Project` found 15 restricting or NO ACTION edges in the cascade closure, not 6. Also blocking: `FrozenPublicationState` to `ClipExport` and `ClipExportVariant`, `ReviewApprovalOverride.exportId`, `ReviewRoundContext.sourceCommentId`, `SocialPublicationAttempt.frozenStateId` and `.priorAttemptId`, `RenderGroup.preparationId`, `Transcript.sourceAudio`. All 14 now cascade. `PublicationManualDecision.workspaceId` also cascades, so Workspace deletion works. One edge stays: `RenderGroup_attemptToken_id_fkey` is safe because `RenderGroupExecution` is only reachable through its group, and a test pins the list to that edge.
   Consequence handled: Cascade would have let a single-Clip delete or a regeneration erase review and publishing evidence. `clip-history.ts` keeps both refused: `deleteClip` answers `clip_has_publication_history` before any storage delete, and `replaceDetectedClipsWithinTransaction` throws as the FK did. The old single-Clip path deleted storage first, then failed.
2. Orphans. Confirmed. `deleteProject` now marks the Project (`retentionPolicyKey: user_deleted_v1`, `expiresAt` and `purgeStartedAt` = now) and dispatches the retention purge. `runProjectDeletion`, its storage planner, `ProjectDeletionIncompleteError` and `project_deletion_incomplete` are gone. Guards run inside the transaction under `lockExecutionRecoveryParents`. A running IngestJob blocks; a queued one does not, because the purge cancels it and intake deletion before settlement is a tested flow. The hourly planner re-drives a lost dispatch. `clear_unexpired` excludes `user_deleted_v1`, otherwise a plan change could undelete a Project. Release keeps reason `project_deleted`.
   The reverse gap was real too: retention never collected `Transcript.rawStorageKey`. It is now admitted under a new `transcript_raw` class.
3. Wedge on unpinned upload. Confirmed. The `artifacts` phase admits `upload_source` for a non-artifact `sourceStorageKey`, and for the `UploadSession.storageKey` of the Project. Admission is idempotent, so this is safe alongside ticket 04 retiring the upload after a pin. The `references` check now also covers raw transcripts, `SourceAudio` and `ExportBundle` keys.
4. Indexes. All 10 added, plus `SocialPublicationAttempt.priorAttemptId`, because that FK now cascades.
5. Clip list. Confirmed. Explicit `clipSnapshotSelect` and `clipRenderVariantSelect`; the type is narrowed, so the compiler proves no caller needs dropped fields.
6. Folder counts. Confirmed, and they also counted expired Projects. `project.groupBy` by Workspace, in `listFolders` and `search`.
7. Workflow history. `getWorkflowEventsSince` replaced by `getRecentWorkflowEvents` (its only caller).
8. `listProjects`. `projectSnapshotSelect` drops the brand snapshots. New `listRecentProjects` skips the count query for `/home`.
9. Bootstrap. Memberships are listed once and also answer selection (`selectListedWorkspace`), avatars (`presignAvatarUrls`) and the plan (`getAuthorizedUsageSummary`). `resolveWorkspaceContext` remains for first use only. Comments corrected in `identity.ts` and `workspace.ts`.
10. Visual asset. JSONB containment in SQL; `visualAssetIsReferencedByClipStorage` removed. Scene and B-roll references are covered in `brand-profile.db.test.ts`.
11. Invites. Partial unique `WorkspaceInvite_pending_email_key`; older duplicates are revoked first. `createInvite` is transactional, and an advisory lock serializes `issueInvite`.
12. Retention. Confirmed. `analyticsEnabled` was true only on the dubbing and export-bundle failure events, and nothing ever published them. Columns, flags and the retention clause are removed.
13. Dead columns and indexes. Verified with a repo-wide search including `apps/media`, scripts and raw SQL. Dropped: `WorkflowEvent` `availableAt`, `deliveryLeaseOwner`, `deliveryLeaseExpiresAt`, `deliveryAttempts`, `nextDeliveryAt`, `analyticsRequired`, `analyticsPublishedAt`, `deadLetteredAt`, `lastDeliveryError` and its 2 indexes; `Clip.autoLayoutClaimToken`, `autoLayoutLeaseExpiresAt`, `autoLayoutAttemptCount` and index; `CompletionCallback.nextObservationAt` and index. All 8 redundant indexes dropped.
14. Drift. All 9 raw indexes modelled with `map:`, 7 FKs with `onUpdate: NoAction`, the `OutboundDelivery.workspace` relation added (and counted as protected content in the pending Workspace removal check), 2 defaults aligned. `migrate diff` now proposes only the HNSW drop. New gate `test:schema-drift:db` allows exactly that line.
15. CHECK constraints. `WorkflowRun.status` and `.stage`, `ReviewRound.status`, `GenerationFinishing.state`, `CampaignOperation.status`, `NotificationLedger.status`. `WorkflowRun.status` adds `cancelled`, which the retention pipeline writes and `workflowStatusSchema` omits.

Concurrent reader found after the drop: ticket 03's `execution-ledger-retention.ts` used `CompletionCallback.nextObservationAt` as its clock. It now uses `updatedAt` (one line in that file), backed by a new `[updatedAt, id]` index.

**Rejected:** none. Finding 1's "NO ACTION was tested and still fails" holds: each cascade runs as its own statement, so order decides.

**Evidence (local test database)**

| Query | Before | After |
|---|---|---|
| Bootstrap | 14 statements (12 + 2 identity) | 6 (4 + 2 identity) |
| Clip list, 40 frozen renders | 40 render rows | 0 render rows |
| Folder count, 30,000 Projects | Seq Scan, 30,000 rows, 9.5 ms | Index Scan, 100 rows, 0.6 ms |
| Latest ContentPack, 60,006 rows | Seq Scan, 49.3 ms | Index Only Scan, 0.11 ms |
| Workflow history, 1,000 events | 1,000 rows | 200 rows |

Red check: restoring the old FK actions on a disposable schema failed 3 of 4 tests in `project-retention-execution.db.test.ts` (`ReviewRoundItem_clipId_fkey`); all 4 pass with the migration.

**Left for later:** a raw Scribe payload that fails normalization is stored but never recorded on a row, so neither path can delete it. Fixing it needs a provider-side record in ticket 06's area; retention never lists a bucket.

**Verification (2026-11-04, local test database only, other tickets in progress in the same checkout)**

- Migration applied on disposable schemas. `test:schema-drift:db` passes.
- Gates passing: `clip-editor-persistence` (36), `brand-profiles` (51), `social-publication` (137), `vizard-expansion` (105), `processing-usage` (35), `workspace-billing` (36), `project-retention-execution` (4), `project-actor-scope` (14).
- `test:workflow:db`: 100 pass, 68 fail. `test:execution:db` suites: 494 pass, 40 fail, with `media-cleanup-recovery` run apart (1 fail). Traced causes are other tickets' uncommitted work: `worker_invalid_payload` (ingest source definition, ticket 04), `appendStableExecutionDispatch is not defined` (render lifecycle), and fixtures in tests new in this pass (`execution-ledger-retention`, `progress-outbox`, `targeted-execution`). Re-run both gates once tickets 03, 04 and 05 land.
- `typecheck` passes in services, auth, api, web and mcp-core. Route inventory, OpenAPI, migration list and web split pass.

**Owner steps**

1. Before `prisma migrate deploy`, list the values on `narriflow-dev`. Any value outside the CHECKs fails the migration:
   `SELECT DISTINCT status FROM "WorkflowRun"; SELECT DISTINCT stage FROM "WorkflowRun"; SELECT DISTINCT status FROM "ReviewRound"; SELECT DISTINCT state FROM "GenerationFinishing"; SELECT DISTINCT status FROM "CampaignOperation"; SELECT DISTINCT status FROM "NotificationLedger";`
2. Deploy the API straight after the migration. A running older Worker writes the dropped `WorkflowEvent` columns and fails until replaced.
