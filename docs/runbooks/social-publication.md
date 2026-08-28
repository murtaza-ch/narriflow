# Social Publication operations

Social Publication Attempt is the only owner of provider delivery. Deploy the database migrations through `20260828231000_social_publication_operation_lookup` before starting the web or worker process. Drain social workers before migration. Narriflow has no production users or mixed-version deployment contract, so obsolete local nonterminal fixtures are reset instead of supported through dual paths.

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

Invalid values stop startup. Meta Graph `v24.0` and LinkedIn `202608` are shared web/worker capability contracts. Configured values must match them, and upgrades must change the shared contract and adapter fixtures together.

Provider recovery contracts:

- YouTube: `youtube.upload`; resumable upload sessions use bounded chunks and are status-probed with the total byte count before resuming the provider-reported range. Audit-enforced accounts stay private.
- Instagram: `instagram_content_publish`; the configured professional-account ID owns one durable Reel container. `IN_PROGRESS`, `FINISHED`, `PUBLISHED`, `ERROR`, and `EXPIRED` are the only accepted container states.
- TikTok: `video.publish`; creator settings are refreshed before initialization. Content Posting webhook signatures use the raw body, `TikTok-Signature`, HMAC-SHA256, and a five-minute replay window. Duplicate or out-of-order events cannot reverse an accepted receipt.
- LinkedIn: `w_member_social` or `w_organization_social`; exact lost-response recovery additionally needs `r_member_social` or `r_organization_social`. Requests send the pinned `Linkedin-Version` and Rest.li protocol header.
- X: `tweet.write` and `media.write`; exact lost-response recovery additionally needs `tweet.read` and `users.read`. Matching uses attached media keys, never text alone.

## Diagnosis and recovery

Use structured `social_publication_*` diagnostics keyed by attempt ID, claim ID, platform, phase, and normalized error code. Logs must never contain access or refresh tokens, webhook signing secrets, reconciliation tokens, scoped media URLs, storage keys, captions, response bodies, or encrypted checkpoint contents.

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
bun run typecheck
bun run lint
bun run test
bun run build
```

The database runner creates a disposable schema, applies the complete migration chain, exercises concurrent intent replay, claim/account fencing, atomic receipt settlement, and retry lineage, then drops the schema unless `SOCIAL_PUBLICATION_TEST_KEEP_SCHEMA=1`.

Use a real authenticated Chrome session to check Publish and Calendar at desktop and narrow widths. Verify the shared labels and status stripes for every product state, idempotency-key reuse after a simulated lost response, cancellation only before submission, live polling, keyboard focus, and absence of console errors. Do not exercise real provider submission with customer content during UI verification.
