# Social Publication operations

Social Publication Attempt is the only owner of provider delivery. Deploy the database migrations through `20260828170000_provider_receipt_uniqueness` before starting the web or worker process. Drain old workers before migration; the migration deliberately removes local nonterminal Draft, Scheduled, and Publishing fixtures because Narriflow has no production users or mixed-version deployment contract.

## Configuration

Place worker secrets in `apps/worker/.env` and webhook scheduling configuration in the owning web environment. Never use a root `.env`.

Required worker configuration:

- `SOCIAL_PUBLICATION_CHECKPOINT_KEY`: at least 32 characters; encrypts provider operation checkpoints.
- Existing provider OAuth/application credentials required by each enabled native adapter.

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

## Diagnosis and recovery

Use structured `social_publication_*` diagnostics keyed by attempt ID, claim ID, platform, phase, and normalized error code. Logs must never contain access or refresh tokens, webhook signing secrets, reconciliation tokens, scoped media URLs, storage keys, captions, response bodies, or encrypted checkpoint contents.

- Preparing video: inspect the exact frozen Clip Export variant. A failed variant settles definitively; it does not select another render.
- Scheduled but late: confirm worker health, workspace access, `nextAttemptAt`, and claim admission.
- Publishing: inspect heartbeat and provider deadline. Never edit the Social Post status to force another claim.
- Processing or Reconciling: confirm `nextActionAt`, the phase-specific processing or reconciliation deadline, call budget, and encrypted checkpoint presence. Recovery must address the same operation.
- Needs attention: verify the post on the provider before any new user-authorized publication. Do not change it to Failed or Scheduled.
- Failed with `safe_retry`: the linked retry attempt and backoff are automatic and bounded. Permanent failures require correcting the frozen input through a new Social Post.

Never delete a Provider Receipt, rewrite attempt lineage, release another live claim, or manually reuse an attempt idempotency key.

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
bun test packages/services/src/social-publication-config.test.ts
bun run typecheck
bun run lint
bun run test
bun run build
```

The database runner creates a disposable schema, applies the complete migration chain, exercises concurrent intent replay, claim/account fencing, atomic receipt settlement, and retry lineage, then drops the schema unless `SOCIAL_PUBLICATION_TEST_KEEP_SCHEMA=1`.

Use a real authenticated Chrome session to check Publish and Calendar at desktop and narrow widths. Verify the shared labels and status stripes for every product state, idempotency-key reuse after a simulated lost response, cancellation only before submission, live polling, keyboard focus, and absence of console errors. Do not exercise real provider submission with customer content during UI verification.
