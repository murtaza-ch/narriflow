# Vizard-inspired expansion cutover

This is the pre-production release and rollback procedure for the Brand Profile,
Campaign Operation, Review, publishing-preparation, Scene, and generated-media
expansion. It is not proof that the program is ready. The current evidence and
remaining release gates live in
[`vizard-expansion-completion-evidence.md`](../architecture/vizard-expansion-completion-evidence.md).

Short generated video is not releasable. Keep
`NARRIFLOW_WRITES_GENERATED_VIDEOS=0` until an approved provider adapter and the
ticket 16 production and real-media evidence exist. A configured provider alias
without a registered complete adapter still fails closed.

## Safety contract

- Deploy additive migrations before code that writes the new records. Never
  roll back by dropping a column, reverting a migration, or deleting an object.
- A rollout value enables writes only when it is exactly `1`. Missing, empty,
  and every other value fail closed.
- Rollout changes are process configuration. Restart every web or worker process
  that consumes a changed value; do not assume a cached runtime will reload it.
- Disabling a write control must leave existing projects, Clip Editor Documents,
  immutable Clip Exports, Review Rounds, Campaign Operations, generated jobs,
  Visual Assets, and Social Posts readable.
- Never repair a lifecycle by editing a status, claim, decision, counter,
  storage key, or usage reservation directly. Replay the owning idempotent
  service operation or use its explicit retry/revoke action.
- Logs and tickets may contain stable IDs, status, counts, platform, bounded
  error codes, and duration buckets. They must not contain prompts, transcript
  or comment text, reviewer email, review tokens or passcodes, API keys,
  provider payloads, signed URLs, or private storage keys.

## Preflight

Run from the repository root against the release database and the exact release
revision:

```sh
(cd packages/db && bunx prisma migrate status)
bun run --cwd packages/db prisma:generate
bun run typecheck
bun run lint
bun run test
bun run test:workflow:db
bun run test:upload-session:db
bun run test:workspace-billing:db
bun run test:social-publication:db
bun run test:clip-editor-persistence:db
bun run test:authenticated-request-policy:db
bun run test:brand-profiles:db
bun run test:vizard-expansion:db
bun run build
```

Also complete the focused provider, worker, MCP, browser, and real-media gates
listed in the completion-evidence document. Stop if migration status is not up
to date, a pending migration has not been applied, the web and worker are not
from the same revision, or any secret required by the stage being enabled is
absent.

Record before enabling writes:

- release revision and migration status;
- database backup or pre-production branch/restore point;
- enabled web and worker controls, without secret values;
- queue depth and oldest age for Campaign Operations, Workflow Runs, Review
  Notifications, Generated Media Jobs, thumbnail jobs, and scheduled posts;
- the analytics baseline described below;
- one fixture ID per readback drill. Never use customer content for a rollout
  exercise.

## Rollout and rollback matrix

All `NARRIFLOW_WRITES_*` values below belong in the web deployment unless the
row explicitly names the worker. Enable one row at a time and complete its
mutation plus rollback/readability drill before proceeding.

| Control | Enables new writes | Roll back and prove readability |
| --- | --- | --- |
| `NARRIFLOW_WRITES_BRAND_PROFILES` | Brand Profile create/update/default/delete and profile membership; Scene Template routes also require this control | Set to `0`, restart web, verify `GET /api/brand-profiles` and `GET /api/brand-profiles/{id}` still return the fixture, while a profile mutation returns `program_write_disabled` |
| `NARRIFLOW_WRITES_VISUAL_ASSETS` | Visual Asset upload admission, finalization, and soft delete | Disable and restart web; verify `GET /api/visual-assets` and an existing Studio scene still resolve the asset, while upload admission is blocked |
| `NARRIFLOW_WRITES_BRAND_FONTS` | Brand Font upload/finalize/delete and font membership | Disable and restart web; verify `GET /api/brand-fonts` and the existing branded Studio document remain readable, while font upload is blocked |
| `NARRIFLOW_WRITES_BRAND_KIT_PROJECTION` | Project Brand Profile and selected style projection changes | Disable and restart web; verify the project and its frozen brand/style state still render, while a new projection mutation is blocked |
| `NARRIFLOW_WRITES_CAMPAIGN_OPERATIONS` | Parent admission for durable selected brand, style, Scene, motion, export-bundle, and recorded render operations; each mutation also requires its ordered child stage below | Disable and restart web; verify `GET /api/projects/{projectId}/campaign-operations` and existing bundle status/download remain readable, while a new selected mutation is blocked. The pre-existing render-selected path continues without recording a Campaign Operation by current contract |
| `NARRIFLOW_WRITES_REVIEW_ROOMS` | New Review Rounds and resubmissions, including API/MCP creation | Disable and restart web; verify the internal Review tab and an already-authorized guest room remain readable and approval evaluation still uses the frozen round; new round creation must fail with `program_write_disabled` |
| `NARRIFLOW_READS_REVIEW_GUEST` | Guest authentication, room reads, and submitted media/download resolution | Disable and restart web; both new access and an existing session must receive the same generic `review_access_temporarily_unavailable` response. Verify the round, session grant, comments, and decisions are unchanged, then re-enable and read the same round with the same session |
| `NARRIFLOW_WRITES_REVIEW_FEEDBACK` | New guest comments, edits, deletes, decisions, and new internal comments | Disable and restart web; verify existing discussion and decisions remain readable while each new feedback mutation returns `review_feedback_temporarily_unavailable`. Revoke, resolve, and reopen remain available incident controls |
| `NARRIFLOW_WRITES_REVIEW_NOTIFICATIONS` | New Review Notification ledger admission in web and due-row claim/delivery in worker | Set the same value to `0` in web and worker and restart both. Decisions and internal comments must still commit, with a content-free `notification_admission_suppressed` audit event and no new notification row. Existing pending/failed rows remain visible and unclaimed; resend/retry returns `review_notifications_temporarily_unavailable`. Re-enable both processes and use resend or retry to resume with stable provider idempotency |
| `NARRIFLOW_WRITES_SCENE_CARDS` | New or changed text/color Scene Blocks | Disable and restart web; read the existing Clip Editor Document and export, then prove a card-scene mutation is blocked |
| `NARRIFLOW_WRITES_SCENE_IMAGES` | New or changed image Scene Blocks | Disable and restart web; read the existing image scene and export, then prove an image-scene mutation is blocked |
| `NARRIFLOW_WRITES_SCENE_VIDEOS` | New or changed video Scene Blocks | Disable and restart web; read the existing video scene and export, then prove a video-scene mutation is blocked |
| `NARRIFLOW_WRITES_SCENE_TEMPLATES` | Scene Template service mutations and insertion through Campaign Operations | Disable and restart web; verify the existing profile template list and frozen inserted scene remain readable, while template creation/insertion is blocked |
| `NARRIFLOW_WRITES_GENERATED_MEDIA` | Generated-media admission and job execution as a whole; must be enabled in every process that creates or executes jobs | Set to `0` in web and worker, restart both, verify existing job status, quota summary, and published Visual Asset remain readable, prove submission is `generated_media_not_configured`, and verify the worker still emits bounded prompt/orphan maintenance results |
| `NARRIFLOW_WRITES_GENERATED_IMAGES` | Image admission and worker adapter, in addition to the generated-media parent control | Set to `0`, restart web and worker, verify existing image jobs/assets, quota summary, and inserted scenes remain readable, and prove new image submission is unavailable while maintenance remains active |
| `NARRIFLOW_WRITES_GENERATED_VIDEOS` | Worker short-video adapter, in addition to the parent control and complete provider configuration | Keep `0`. Do not run a rollout drill until ticket 16's entry gate and provider evidence are complete |
| `NARRIFLOW_WRITES_ASSISTED_COPY` | First publishing-preparation stage: new assisted-copy drafts | Disable and restart web; verify `GET /api/projects/{projectId}/assisted-copy/{draftId}` still returns the existing draft while generation and every later publishing-preparation stage are blocked |
| `NARRIFLOW_WRITES_THUMBNAIL_EXTRACTION` | Second publishing-preparation stage: new immutable-export thumbnail jobs; assisted copy must also be enabled | Disable and restart web; verify `GET /api/projects/{projectId}/thumbnail-extractions/{jobId}` and its resulting Visual Asset remain readable while thumbnail and bulk admission are blocked |
| `NARRIFLOW_WRITES_BULK_SCHEDULING` | Final publishing-preparation stage: new Campaign Operation batches that create frozen Social Posts; copy, thumbnail, and Campaign delivery stages must also be enabled | Disable and restart web; verify existing Campaign Operation and Social Post rows remain readable and the social worker can finish already admitted posts, while a new batch is blocked |

### Ordered feature stages

These controls are dependency chains, not independent toggles. A later value
set to `1` remains closed when any predecessor is missing or not exactly `1`.
Exercise one synthetic fixture at each step before opening the next step.

| Feature | Required order | Rollback drill |
| --- | --- | --- |
| Auto Censor | `NARRIFLOW_WRITES_CENSOR_SCAN` → `NARRIFLOW_WRITES_CENSOR_CAPTION_MASK` → `NARRIFLOW_WRITES_CENSOR_MUTE` → `NARRIFLOW_WRITES_CENSOR_BEEP` | With scan only, verify a Free project receives at most 10 preview suggestions and cannot persist them. After each treatment opens, apply one segment and compare preview/export. Set that treatment and every later treatment to `0`, restart web, and verify the saved segment still previews and renders; disabling and deleting it must remain available while a new segment of that treatment is rejected before persistence. |
| Motion | `NARRIFLOW_MOTION_SHADOW_LEGACY_TRANSITIONS` → `NARRIFLOW_WRITES_MOTION_CROSS_DISSOLVE` → `NARRIFLOW_WRITES_MOTION_DIRECTIONAL_WIPE` → `NARRIFLOW_WRITES_MOTION_DIRECTIONAL_SLIDE` → `NARRIFLOW_WRITES_MOTION_ZOOM` → `NARRIFLOW_WRITES_MOTION_MEDIA_FADE_SCALE` → `NARRIFLOW_WRITES_MOTION_PAN_KEN_BURNS` → `NARRIFLOW_WRITES_MOTION_CAMPAIGN_APPLY` | At every family, save one representative motion and compare browser and real-media output. Set that family and all later controls to `0`, restart web, and verify the saved value remains visible, previews/renders unchanged, and can be removed. It must disappear from new-preset choices and a direct document or Campaign mutation must fail before persistence. |
| Campaign actions | `NARRIFLOW_WRITES_CAMPAIGN_OPERATIONS` → `NARRIFLOW_WRITES_CAMPAIGN_RENDER` → `NARRIFLOW_WRITES_CAMPAIGN_EXPORTS` → `NARRIFLOW_WRITES_CAMPAIGN_CREATIVE` → `NARRIFLOW_WRITES_CAMPAIGN_DELIVERY` | First prove Render selected keeps its existing visible behavior while its audit adoption is off, then prove recorded render, export/ZIP, selection-scoped brand/style/Scene/motion, and finally delivery in order. Review appears only when Review Room creation is also enabled. Scheduling appears only after the ordered assisted-copy/thumbnail/bulk controls below are enabled. Roll back the active stage, restart web, verify history and existing bundles remain readable/downloadable, and assert the same new service mutation is rejected before database access. |
| Publishing preparation | `NARRIFLOW_WRITES_ASSISTED_COPY` → `NARRIFLOW_WRITES_THUMBNAIL_EXTRACTION` → `NARRIFLOW_WRITES_BULK_SCHEDULING` | Enable and verify a confirmed copy revision before thumbnail extraction, then verify both before bulk scheduling. Setting a predecessor to `0` must close every later admission while existing drafts, assets, operations, and Social Posts remain readable. |

Review approval enforcement has a separate staged policy. It defaults to
`enforce`. Set `NARRIFLOW_REVIEW_APPROVAL_MODE=warn` to continue exact-export
evaluation while allowing the schedule and emitting only a bounded
`review_approval_warn_only` structured warning. Warn mode never creates an
approval decision or Review Approval Override. To stage enforcement, keep the
mode at `enforce` and set comma-separated UUIDs in
`NARRIFLOW_REVIEW_APPROVAL_ENFORCE_WORKSPACE_IDS` and/or
`NARRIFLOW_REVIEW_APPROVAL_ENFORCE_PROJECT_IDS`; matching either cohort is
enforced and all other scopes remain warn-only. Invalid cohort configuration
fails closed. Empty cohorts mean global enforcement.

The Review controls above are independent and have disposable-schema
preservation coverage. The program-wide rollback criterion remains open until
operators record the drill for every matrix row against the final deployment;
passing a synthetic contract test is not production rollout evidence.

## Release sequence

1. Turn every expansion write control off in the release configuration.
2. Apply the complete migration chain, regenerate Prisma, and deploy tolerant
   readers. Start web and worker from the same revision.
3. With writes still off, run the readback drill against an existing v2 editor
   document, Brand Profile, Visual Asset, Campaign Operation, Review Round,
   generated-image job, Export Bundle, assisted-copy draft, thumbnail job, and
   Social Post.
4. Enable foundational ownership controls: Brand Profiles, Visual Assets,
   fonts, Brand Kit projection, and the four Scene controls. Exercise one
   bounded fixture per control and switch it off again to prove the read path.
5. Enable Auto Censor through scan, caption mask, mute, and beep, completing
   the bounded Free-preview and saved-segment rollback drill at each stage.
6. Enable Campaign Operations through its ordered render, export, creative,
   and delivery stages. Within creative, complete the ordered Motion stages
   before selection-scoped apply. Enable Review Rooms only before exercising
   the Campaign delivery review action. Exercise immutable export selection,
   change request, resubmission, approval, revocation, and the exact-export
   publishing gate. Do not use an override for the happy path.
7. Enable assisted copy, thumbnail extraction, and bulk scheduling in that
   order. Confirm
   every scheduled Social Post freezes the exact editor revision, export
   variant, confirmed copy revision, thumbnail, and approval/override audit.
8. Enable generated images in both web and worker only after the provider,
   moderation, usage, R2, cleanup, and browser gates pass. Leave generated
   video disabled.
9. Enable Business REST and MCP clients only after their corresponding web
   lifecycle is stable. Test REST with a least-privilege API key, then MCP with
   both a least-privilege API key and an OAuth user principal.
10. Hold the rollout until the post-release metrics window is complete. Do not
   remove warnings or mark ticket 18 done from a single happy-path fixture.

## Standard rollback/readability drill

For each matrix row:

1. With only that control enabled, create one synthetic fixture through the
   product or public service boundary. Save stable row IDs and safe status
   fields, not access secrets or customer content.
2. Set the control to `0`, restart its process, and repeat the documented GET or
   UI read. Existing data and immutable media must remain available.
3. Attempt the same class of new mutation with a fresh idempotency key. Assert
   the stable disabled/not-configured error and verify the row/object counts did
   not change.
4. Re-enable, restart, and replay the original idempotency key. Assert one
   durable operation/result and a replay response, not a duplicate.
5. Disable once more if the next release stage has not been approved.

For Review Rooms, exercise creation, guest read, feedback, and notification
controls one at a time. Disabling creation or feedback must not invalidate an
already-authorized guest session. Disabling guest read must deny that session
without changing its grant or durable round, so the same session works after
re-enable. Revocation must still invalidate it without revealing project,
clip, reviewer, or decision metadata. For generated media, verify disabled web
admission creates no reservation and a disabled worker claims no work, while
existing jobs, quota summaries, and completed assets still resolve. Keep the
worker process running so config-independent prompt and orphan maintenance can
continue with every generated-media write/provider control off.

## Reconciliation and bounded cleanup

Use the product projections first. The SQL below is read-only diagnosis for a
psql session; set only UUIDs and do not select secret-bearing columns.

```sql
BEGIN TRANSACTION READ ONLY;
\set workspace_id '00000000-0000-4000-8000-000000000000'
\set project_id '00000000-0000-4000-8000-000000000000'
-- Run one of the following diagnosis blocks, then:
COMMIT;
```

### Campaign Operations

Read `GET /api/projects/{projectId}/campaign-operations` first. Diagnose a
specific project without selecting validated options or per-item result JSON:

```sql
SELECT o.id, o.action, o.status, o."requestedCount", o."succeededCount",
       o."unchangedCount", o."staleCount", o."ineligibleCount",
       o."failedCount", o."retryOfId", o."workflowRunId",
       o."leaseExpiresAt", o."createdAt", o."completedAt"
FROM "CampaignOperation" o
WHERE o."workspaceId" = :'workspace_id'::uuid
  AND o."projectId" = :'project_id'::uuid
ORDER BY o."createdAt" DESC
LIMIT 100;

SELECT i."operationId", i.status, i."errorCode", count(*)
FROM "CampaignOperationItem" i
JOIN "CampaignOperation" o ON o.id = i."operationId"
WHERE o."workspaceId" = :'workspace_id'::uuid
  AND o."projectId" = :'project_id'::uuid
GROUP BY i."operationId", i.status, i."errorCode"
ORDER BY i."operationId", i.status;
```

An exact replay after a lost response must use the original operation's
idempotency key and identical request. The service reclaims expired item leases
on that replay. A changed request needs a new key; never bypass an idempotency
conflict. Use the explicit render or Export Bundle retry only for the source
operation's retryable failed items; one source operation accepts at most one
linked retry. `stale` and `ineligible` are product outcomes, not rows to repair.

There is no destructive Campaign Operation cleanup. Keep operations and item
outcomes as the audit record.

### Review Rounds

Use the internal Review tab or `GET /api/projects/{projectId}/review-rounds`.
The Business API and MCP projections intentionally omit tokens, passcodes,
recipients, comments, and guest identity.

```sql
SELECT r.id, r.revision, r.status, r."approvalRequired", r.decision,
       r."previousRoundId", r."sentAt", r."expiresAt", r."revokedAt",
       r."supersededAt", r."decidedAt", count(i.id) AS item_count
FROM "ReviewRound" r
LEFT JOIN "ReviewRoundItem" i ON i."reviewRoundId" = r.id
WHERE r."workspaceId" = :'workspace_id'::uuid
  AND r."projectId" = :'project_id'::uuid
GROUP BY r.id
ORDER BY r.revision DESC;
```

Create a changed submission as a new round with `sourceRoundId`; do not mutate
the frozen items on the prior round. Revoke an incorrect live round through
`POST /api/projects/{projectId}/review-rounds/{roundId}/revoke`. Expiry is
evaluated from `expiresAt`; do not rewrite status to simulate it. Preserve
comments, decisions, recipients, audit events, and approval overrides. Review
Rounds have no destructive retention cleanup in the shipped contract; revoke
access rather than deleting evidence.

### Review Notifications

The worker's `notification_retry` loop claims pending or expired-lease rows in
batches (`NOTIFICATION_RETRY_BATCH_SIZE`, default 25). Review delivery has a
five-minute lease, at most five automatic attempts, and exponential retry from
30 seconds to one hour. The provider idempotency key is derived from the
notification ID.

```sql
SELECT n."reviewRoundId", n.kind, n.status, n."attemptCount",
       n."nextAttemptAt", n."leaseExpiresAt", n."failureCode",
       n."sentAt", count(*) OVER () AS matching_rows
FROM "ReviewNotification" n
JOIN "ReviewRound" r ON r.id = n."reviewRoundId"
WHERE r."workspaceId" = :'workspace_id'::uuid
  AND r."projectId" = :'project_id'::uuid
ORDER BY n."createdAt" DESC
LIMIT 100;
```

An expired `claimed` lease is reclaimed automatically. Pending rows remain in
the automatic delivery queue and are not manually retryable. Retry a visible
`failed` row through the Review tab or
`POST /api/projects/{projectId}/review-rounds/{roundId}/notifications/{notificationId}/retry`;
that action preserves the failed source row, creates one idempotent immutable
retry-lineage row, and records a Review audit event. Do not retry `pending` or
`sent`, fabricate a provider message ID, decrypt recipient email for diagnosis,
or delete notification rows.

For an email incident, set `NARRIFLOW_WRITES_REVIEW_NOTIFICATIONS=0` in both
web and worker and restart them. The web app stops admitting new ledger rows,
while the worker lists or claims no due Review Notifications. It does not mark
pending rows failed or increment attempts. Feedback remains durable; its
suppressed delivery intent is visible only as a content-free Review audit
event. Re-enable both processes, then use the explicit resend/retry actions;
never fabricate the rows or provider receipt manually.

### Generated Media Jobs

Read job status through Studio, Business REST, or MCP. Those projections omit
prompts, provider controls/payloads, source content, storage keys, and URLs.

```sql
SELECT j.id, j.kind, j.status, j.provider, j.model, j."attemptCount",
       j."nextAttemptAt", j."nextPollAt", j."claimExpiresAt",
       j."cancelRequestedAt", j."moderationOutcome", j."errorCode",
       j."providerUsageUnits", j."resultAssetId", j."insertionCount",
       j."completedAt", u.status AS usage_status,
       u."reservedUnits", u."finalizedUnits", u."releasedUnits"
FROM "GeneratedMediaJob" j
LEFT JOIN "GenerationUsageReservation" u ON u."jobId" = j.id
WHERE j."workspaceId" = :'workspace_id'::uuid
  AND j."projectId" = :'project_id'::uuid
ORDER BY j."createdAt" DESC
LIMIT 100;
```

The worker reclaims an expired `running` claim, polls only `waiting` jobs that
have both a provider reference and a due `nextPollAt`, and fences every
settlement by claim ID. A nonpollable or indeterminate result is
`reconciliation_required`: it has no next poll, consumes no active-concurrency
slot, keeps its usage reservation and provider/result evidence, and is never
claimed automatically. This includes a provider success response whose bytes
cannot be decoded or whose deterministic result write cannot be proven. Do not
submit a replacement, release usage, attach an asset manually, or change the
row to `waiting`; escalate with the content-safe job ID and error code.

Maintenance purges encrypted prompt material only after `promptDeleteAfter`, in
batches of 100. It compares R2 keys below
`generated-media/provider-results/` and `generated-media/assets/` with durable
job and Visual Asset references, then deletes at most 100 unreferenced objects
per prefix that are at least 24 hours old. Monitor the structured
`generated_media_maintenance` event; a non-zero `objectFailures` is an incident,
not permission to remove database references. A deterministic result reference
held by `reconciliation_required` remains a durable reference and is excluded
from orphan deletion. Maintenance is deliberately available when every
generated-media write and provider flag is off; do not gate or stop its loop as
part of rollback.

### Generated-media quota and prompt-protection configuration

Web and worker must use the same quota and prompt-protection configuration
before either process is enabled. Image defaults are 1 unit per job, a
20-unit UTC-day metered allowance, and a 40-unit UTC-day abuse ceiling. Video
usage summaries default to 6, 60, and 120 units respectively, but video cannot
be enabled until `GENERATED_VIDEO_USAGE_UNITS` and every other ticket 16
provider setting are explicit. Free has one lifetime generated-image trial;
live reservations and finalized units consume allowance, while a known
released failure restores allowance. Every admitted attempt, including a
released one, still consumes the daily abuse ceiling. Quota summaries remain
readable with rollout disabled.

Set independent values of at least 32 characters for
`GENERATED_MEDIA_PROMPT_ENCRYPTION_KEY` and
`GENERATED_MEDIA_PROMPT_FINGERPRINT_KEY`, and name the active encryption key
with `GENERATED_MEDIA_PROMPT_ACTIVE_KEY_VERSION` (there is no implicit runtime
default). `GENERATED_MEDIA_PROMPT_DECRYPTION_KEYS_JSON` defaults to `{}` and maps
prior version names to their decryption keys. To rotate encryption, first put
the old active version/key in that JSON in both processes, then deploy the new
active version/key everywhere while keeping the fingerprint key unchanged.
Retain prior decryption keys until no stored prompt ciphertext using that
version can require decryption. Fingerprint-key rotation is not supported by
this release because it would invalidate stable prompt/idempotency
fingerprints. `GENERATED_MEDIA_PROMPT_RETENTION_MS` defaults to `2592000000`
(30 days).

### Export Bundles

Use `GET /api/projects/{projectId}/export-bundles` and the owning Workflow Run.

```sql
SELECT b.id, b.status, b."operationId", b."workflowRunId", b."sizeBytes",
       b."checksumSha256", b."expiresAt", b."errorCode", b."createdAt",
       b."completedAt", w.status AS workflow_status,
       w."attemptCount" AS workflow_attempts, w."leaseExpiresAt"
FROM "ExportBundle" b
JOIN "CampaignOperation" o ON o.id = b."operationId"
JOIN "WorkflowRun" w ON w.id = b."workflowRunId"
WHERE o."workspaceId" = :'workspace_id'::uuid
  AND o."projectId" = :'project_id'::uuid
ORDER BY b."createdAt" DESC
LIMIT 100;
```

The Workflow Run lifecycle reaps expired attempts. A failed bundle may be
retried through
`POST /api/projects/{projectId}/export-bundles/{bundleId}/retry` or the source
operation retry route; the retry freezes only retryable failed items. Do not
reuse a stale mutable Clip revision or substitute a newer export.

The worker expiry cleanup scans at most 500 expired completed bundles per call
(`EXPORT_BUNDLE_EXPIRY_BATCH_SIZE` defaults to 100), deletes the published R2
object first, then marks the row `expired` and clears its storage key. Failed
deletes emit `export_bundle_expiry_delete_failed` and leave the row/object
linked for the next bounded attempt.

Before an Export Bundle worker writes remote bytes, its owning Workflow Attempt
admits two durable exact-key `MediaCleanupObligation` rows: the staging key and
that attempt's would-be publication key. Both stay held by the producer for 24
hours, which is longer than the bounded bundle build. Publishing adopts the
final-key obligation in the same database transaction that stores
`ExportBundle.storageKey`; the adopted receipt is never claimable. Normal
success/failure deletes the attempt-scoped object and settles its obligation.
If the process crashes at any remote stage, the hold expires and the Media
Cleanup worker claims only those recorded exact keys in batches of 25. A
missing object is idempotent success; a failed delete remains due with bounded
backoff. There is no prefix sweep and no cleanup obligation is admitted for
immutable Clip Export objects.

### Visual Assets

Use `GET /api/visual-assets` and inspect reference counts without selecting the
private storage key:

```sql
SELECT a.id, a.kind, a.provenance, a."contentType", a."sizeBytes",
       a.width, a.height, a."durationSec", a."deletedAt",
       count(DISTINCT pa.id) AS profile_refs,
       count(DISTINCT st.id) AS scene_template_refs,
       count(DISTINCT sp.id) AS social_thumbnail_refs
FROM "VisualAsset" a
JOIN "Workspace" w ON w.id = :'workspace_id'::uuid
LEFT JOIN "BrandProfileAsset" pa ON pa."assetId" = a.id
LEFT JOIN "SceneTemplate" st ON st."sourceAssetId" = a.id
LEFT JOIN "SocialPost" sp ON sp."thumbnailAssetId" = a.id
WHERE (
  (w."personalOwnerUserId" IS NOT NULL
    AND a."userId" = w."personalOwnerUserId"
    AND a."workspaceId" IS NULL)
  OR
  (w."personalOwnerUserId" IS NULL
    AND a."workspaceId" = w.id
    AND a."userId" IS NULL)
)
GROUP BY a.id
ORDER BY a."createdAt" DESC
LIMIT 100;
```

Delete reusable assets only through the service. It requires reference removal
or a same-kind replacement and performs a soft delete. Existing frozen Clip
Editor Documents and exports may still need the object, so soft deletion does
not remove the media. Generated-media orphan maintenance must also treat every
Visual Asset key as referenced.

A Visual Asset upload URL is valid for one hour. After signing succeeds and
before the URL is returned, the service records one exact-key cleanup
obligation whose `nextAttemptAt` is the full URL lifetime plus a five-minute
clock-skew buffer measured from signing completion. Therefore Cleanup cannot
claim the key while the URL is valid. Finalization adopts that obligation in
the same serializable transaction that creates the Visual Asset. Adoption is
allowed only before Cleanup's first claim; an active, expired, released, or
completed cleanup attempt fails finalization with
`visual_asset_upload_ownership_lost`, preventing a database reference from
racing an ambiguous delete. An upload that is never finalized becomes due
after the buffer and is deleted by the bounded exact-key Media Cleanup worker.
Do not scan or delete the Visual Asset prefix manually.

Extracted thumbnails use the same exact-key cleanup ledger with a shorter,
worker-owned lease. Before FFmpeg uploads an extracted JPEG, the claimed
`ThumbnailExtractionJob` admits a held
`visual_asset_upload` / `unfinalized_visual_asset_upload` obligation for that
attempt's deterministic key
`visual-assets/extracted/{workspaceId}/{jobId}/attempt-{attempt}.jpg`.
Completion creates the extracted Visual Asset, completes the job, and adopts
that exact obligation in one serializable transaction. A normal failure
releases the obligation immediately; a worker crash leaves it held only until
the extraction claim expires. The next claim uses a new attempt key, so it
never races cleanup of the abandoned object. Diagnose an orphan by the exact
job ID and object key; never sweep `visual-assets/extracted/` by prefix.

### Assisted-copy unknown outcomes

An assisted-copy reservation has a 30-second generation deadline. `get`,
`listLatest`, and an idempotent replay reconcile an overdue `generating` row to
`unknown` with `assisted_copy_provider_outcome_unknown`, even when provider
configuration or new-write rollout is disabled. A late provider response
cannot overwrite that terminal hold. OpenAI transport loss, timeout, and 5xx
responses after dispatch are also `unknown`; they are not retryable provider
failures. Replaying the same idempotency key returns the held draft without
initializing the provider. After operator diagnosis, an editor may deliberately
regenerate with a new idempotency key. Never blind-retry an `unknown` draft or
rewrite it as `failed`.

### Bulk-scheduling response-loss reconciliation

Every bulk item derives a stable child idempotency key and the Social Post
stores its immutable publication-request hash. If publication scheduling
throws without a stable domain error, the adapter reads by exact Workspace and
child key. A matching committed row is returned as scheduled/preparing, so the
Campaign Operation records one successful item rather than a false failure. A
different hash is a conflict. If no row is readable yet, the adapter returns
`bulk_schedule_publication_reconciliation_required`; the bulk operation is not
settled and an exact replay re-runs the same child key. Do not replace this
with a new bulk or child idempotency key during incident recovery.

## Incident rollback

1. Disable the narrowest affected write control. For generated media, disable
   the individual kind before the parent control; for a worker execution
   incident, stop claims and allow current leases to expire before restarting.
2. Restart the consuming process and prove the disabled mutation is rejected.
3. Run the matching read-only diagnosis and the standard readability drill.
4. Preserve every row, audit record, usage reservation, immutable export, and
   object. Do not deploy a down migration.
5. Reconcile already admitted work through the owning worker/service. If the
   provider outcome is unknown, obtain provider evidence before any retry.
6. Record the control, UTC time, affected IDs, bounded error code, queue depth,
   and recovery result. Exclude customer content and secrets.

## Analytics baseline and post-release record

The approved interval is from `clips_ready` to the first `campaign_scheduled`
event whose selected deliverables met the approval rule. Record, by release
cohort and fixed UTC window:

- eligible projects, scheduled projects, and completion rate;
- median and p90 completion time;
- median and p90 Review revision count;
- Social Publication Attempt failure rate;
- generated-provider failure/rejection rate by provider and kind;
- count and rate of Review Approval Overrides.

Run the content-safe aggregate report twice with fixed, non-overlapping UTC
windows. Repeat `--workspace` for every Workspace in the release cohort; omit
it only for the deliberate all-Workspace operator view.

```sh
bun run report:vizard-analytics -- \
  --from 2026-08-01T00:00:00.000Z \
  --to 2026-09-01T00:00:00.000Z \
  --workspace 00000000-0000-4000-8000-000000000000
```

The report returns no Workspace, Project, Clip, Review, post, job, prompt, or
recipient identifiers. `reviewRevisions` is the highest sent Review revision
at or before each Project's first qualifying schedule. Publication failure is
`failed + needs_attention` divided by terminal attempts in the window.
Generated-provider rates use terminal `completed`, `failed`, and `rejected`
jobs grouped only by configured provider alias and media kind; user-cancelled
jobs are excluded. `approvalOverrideProjectRate` is the fraction of scheduled
Projects whose first qualifying schedule used at least one override.

Metadata is restricted to stable IDs, counts, platform, outcome, duration
bucket, feature version, and bounded guardrails. The current schema validates
this allowlist. Transactional triggers now emit `clips_ready`, Campaign
Operation started/completed, and idempotent `campaign_scheduled` events. The
aggregate completion-interval report returns eligible/scheduled project counts,
completion rate, scheduled deliverables, overrides, median/p90 duration and
Review revisions, terminal publication failures, and generated-provider
outcomes without returning identifiers or content. Disposable-schema tests
prove the exactly-once lifecycle and report contract. Cutover remains blocked
until a fixed baseline and post-release window are recorded from real release
data. Do not manufacture either window from row creation timestamps or
notification events.

## Exit criteria

Cutover is complete only when every dependency ticket is done, every matrix row
has recorded rollback/readability evidence, the full Business agency journey is
proven in a real browser, representative exports match Studio across supported
aspect ratios, provider and production-build gates pass, and baseline plus
post-release metrics are recorded. The completion-evidence matrix is the source
of truth; unchecked rows are blockers, not deferred polish.
