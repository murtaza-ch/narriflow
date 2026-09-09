# Social Publication operations

Social Publication Attempt is the only owner of provider delivery. Deploy the database migrations through `20260909010000_publishing_delivery` before starting the web or worker process. Drain social workers before migration. Narriflow has no production users or mixed-version deployment contract, so obsolete local publication rows without frozen intent are deleted instead of supported through dual paths.

## Configuration

Place worker secrets in `apps/worker/.env` and webhook scheduling configuration in the owning web environment. Never use a root `.env`.

Required worker configuration:

- `SOCIAL_PUBLICATION_CHECKPOINT_KEY`: at least 32 characters; encrypts provider operation checkpoints.
- Existing provider OAuth/application credentials required by each enabled native adapter.
- `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET` in the web environment for the verified Content Posting webhook at `/api/webhooks/tiktok/publication`.

Bounded worker controls:

| Variable | Default | Allowed |
| --- | ---: | ---: |
| `SOCIAL_PUBLISH_BATCH_SIZE` | 20 | 1–100 |
| `SOCIAL_PUBLISH_CONCURRENCY` | 4 | 1–20 |
| `SOCIAL_PUBLISH_LEASE_MS` | 60,000 | 15,000–900,000 |
| `SOCIAL_PUBLISH_HEARTBEAT_MS` | 15,000 | 1,000–300,000 and less than half the lease |
| `SOCIAL_PUBLISH_PROVIDER_DEADLINE_MS` | 300,000 | 1,000–600,000 |
| `SOCIAL_PUBLISH_PROVIDER_CALL_BUDGET` | 100 | 1–100 |
| `SOCIAL_PUBLISH_PROCESSING_DEADLINE_MS` | 86,400,000 | 60,000–604,800,000 |
| `SOCIAL_PUBLISH_RECONCILIATION_DEADLINE_MS` | 86,400,000 | 60,000–604,800,000 |
| `SOCIAL_PUBLISH_MAX_ATTEMPTS` | 4 | 1–10 |

Provider capability controls are validated at startup: YouTube API `v3` with 256 KiB-aligned 256 KiB–256 MiB chunks, Meta Graph `v24.0` with bounded container polling, TikTok API `v2` with 5–64 MiB chunks and polling no faster than five seconds, LinkedIn `202608` with a 30-day pre-sunset startup guard, and X API `v2` with bounded media, chunk, rate-retry, and reconciliation policies. Configure them with `YOUTUBE_API_VERSION`, `YOUTUBE_UPLOAD_CHUNK_BYTES`, `META_GRAPH_VERSION`, `INSTAGRAM_CONTAINER_POLL_ATTEMPTS`, `INSTAGRAM_CONTAINER_POLL_INTERVAL_MS`, `TIKTOK_API_VERSION`, `TIKTOK_UPLOAD_CHUNK_BYTES`, `TIKTOK_STATUS_POLL_INTERVAL_MS`, `LINKEDIN_API_VERSION`, `LINKEDIN_API_VERSION_SUNSET_AT`, `X_API_VERSION`, `X_UPLOAD_CHUNK_BYTES`, `X_MAX_MEDIA_BYTES`, `X_RATE_LIMIT_RETRY_FLOOR_MS`, and `X_RECONCILIATION_MAX_PAGES`. Invalid values stop startup; upgrades must change the shared contract and pinned adapter fixtures together.

Provider recovery contracts:

- YouTube: `youtube.upload`; resumable upload sessions use bounded chunks and are status-probed with the total byte count before resuming the provider-reported range. A confirmed video ID settles Posted immediately. The worker then enriches the retained receipt from `videos.list`, recording processing success or failure and observed privacy without uploading again. Audit-enforced accounts stay private.
- Instagram: `instagram_content_publish`; the configured professional-account ID owns one durable Reel container. `IN_PROGRESS`, `FINISHED`, `PUBLISHED`, `ERROR`, and `EXPIRED` are the only accepted container states.
- TikTok: `video.publish`; creator settings are refreshed before initialization. Moderation polling backs off exponentially to a 30-minute ceiling within the durable processing deadline. Content Posting webhook signatures use the raw body, `TikTok-Signature`, HMAC-SHA256, and a five-minute replay window. Duplicate or out-of-order events cannot reverse an accepted receipt, and Publish again fences the prior lookup hash before scheduling new work.
- LinkedIn: `w_member_social` or `w_organization_social`; exact lost-response recovery additionally needs `r_member_social` or `r_organization_social`. Requests send the pinned `Linkedin-Version` and Rest.li protocol header. Finalized video stays in durable provider processing until LinkedIn reports `AVAILABLE`; only then may the Post be created.
- X: `tweet.write` and `media.write`; exact lost-response recovery additionally needs `tweet.read` and `users.read`. Matching uses attached media keys, never text alone.

## Diagnosis and recovery

Use structured `social_publication_*` diagnostics keyed by attempt ID, claim ID, platform, phase, and normalized error code. Logs must never contain access or refresh tokens, webhook signing secrets, reconciliation tokens, scoped media URLs, storage keys, captions, response bodies, or encrypted checkpoint contents.

Structured `social_publication_metric` events provide counters and timers for queue age, claims, lease takeover, stale settlement, provider operations and duration, processing and reconciliation age, retries, attention, manual decisions, receipts and enrichment, cleanup, and terminal outcomes. Dimensions are limited to platform, phase, outcome, disposition, operation class, and decision class.

- Preparing video: inspect the exact frozen Clip Export variant. A failed variant settles definitively; it does not select another render.
- Scheduled but late: confirm worker health, workspace access, `nextAttemptAt`, and claim admission.
- Publishing: inspect heartbeat and provider deadline. Never edit the Social Post status to force another claim.
- Processing or Reconciling: confirm `nextActionAt`, the phase-specific processing or reconciliation deadline, call budget, and encrypted checkpoint presence. Recovery must address the same operation.
- Needs attention: verify the post on the provider before any new user-authorized publication. Do not change it to Failed or Scheduled.
- Failed with `safe_retry`: the linked retry attempt and backoff are automatic and bounded. Permanent failures require correcting the frozen input through a new Social Post.

Never delete a Provider Receipt, rewrite attempt lineage, release another live claim, or manually reuse an attempt idempotency key.

Use the identifier-safe operator command for one post:

```sh
bun --filter @narriflow/services social-publication:operator -- \
  --workspace <workspace-uuid> --post <social-post-uuid>
```

Request targeted reconciliation only after confirming the account still permits provider reads. This reuses the existing attempt and cannot submit a new post:

```sh
bun --filter @narriflow/services social-publication:operator -- \
  --workspace <workspace-uuid> --post <social-post-uuid> \
  --recheck --actor <user-uuid> --reason "Provider account verified"
```

In the product, Confirm published requires `publishing.manage` and records manual or platform-reference evidence without fabricating metrics. Publish again is only available from Needs attention, requires a reason and explicit duplicate-risk acknowledgement, and creates a linked attempt.

## Deploy, rollback, and escalation

1. Drain every social worker and verify there are no live claims before applying migrations.
2. Apply the complete migration chain, deploy web and worker from the same revision, then restart workers.
3. Observe representative accepted, processing, definitive failure, and Needs attention outcomes plus TikTok webhook signature failures and delivery retries.
4. For rollback, drain workers first. Preserve attempts, encrypted checkpoints, operation lookup hashes, receipts, and manual decisions. Never roll back by scheduling uncertain rows or deleting evidence.
5. Escalate when exact lookup returns multiple matches, provider read permission is unavailable, a processing deadline expires without final evidence, or receipt uniqueness conflicts. Verify the provider account before authorizing Publish again.

For a local-only reset, stop web and worker processes, reset the local database deliberately, reapply migrations, and reconnect provider test accounts. Do not add compatibility reads for obsolete fixture shapes.

## Verification

Run from the repository root:

```sh
bun run --cwd packages/db prisma:generate
bun run test:social-publication:db
bun test packages/services/src/social-publication-platform.test.ts
bun test packages/services/src/social-publication-scheduling.test.ts
bun test packages/services/src/social-publication-attempt.test.ts
bun test packages/services/src/social-publication-native-platforms.test.ts
bun test packages/services/src/social-publication-webhook.test.ts
bun test packages/services/src/social-publication-tiktok-webhook.test.ts
bun test packages/services/src/social-publication-config.test.ts
bun test packages/services/src/youtube-receipt-enrichment.test.ts
bun test packages/mcp-core/src/index.test.ts
bun run typecheck
bun run lint
bun run test
bun run build
```

The database runner creates a disposable schema, applies the complete migration chain, exercises concurrent intent replay, claim/account fencing, atomic receipt settlement, and retry lineage, then drops the schema unless `SOCIAL_PUBLICATION_TEST_KEEP_SCHEMA=1`.

Use a real authenticated Chrome session to check Publish and Calendar at desktop and narrow widths. Verify the shared labels and status stripes for every product state, idempotency-key reuse after a simulated lost response, cancellation only before submission, live polling, keyboard focus, and absence of console errors. Do not exercise real provider submission with customer content during UI verification.

## TikTok inbox configuration and recovery

Enable the Content Posting API’s **Upload** capability and obtain approval for `video.upload` in the TikTok developer application. Direct Post continues to require `video.publish`. Narriflow requests both during connection; reconnect existing accounts to grant inbox upload. An account missing one scope remains eligible for the other mode.

Configure the verified callback `/api/webhooks/tiktok/publication` with the application client key and secret. Subscribe to `post.publish.inbox_delivered`, `post.publish.complete`, `post.publish.publicly_available`, and `post.publish.failed`. Signature verification uses the unmodified request body and a bounded replay window. Inbox events use `publish_type=INBOX_SHARE`; direct events use `DIRECT_POST`.

Inbox requests use `/v2/post/publish/inbox/video/init/` with FILE_UPLOAD `source_info` only. Do not add title, privacy, interaction, cover, or suggested-description fields. Upload chunks retain the existing encrypted checkpoints and resume the same upload after interruption. `SEND_TO_USER_INBOX` settles Sent to TikTok. No periodic poll or delivery timeout continues while the creator decides when to publish.

Use **Refresh TikTok status** after delivery to explicitly fetch later publication evidence. Verified callbacks also enrich settled deliveries. A publication without a public post ID has no link; repeated and multiple IDs are stored as deduplicated child records. Never resend an inbox upload just because no public post appears. For pending-upload limits, ask the creator to complete or clear existing inbox drafts; for revoked permission, reconnect before an explicitly new delivery. Unknown outcomes retain the normal Recheck and duplicate-risk recovery policy.

References: [Upload video](https://developers.tiktok.com/doc/content-posting-api-reference-upload-video), [Status](https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status).
