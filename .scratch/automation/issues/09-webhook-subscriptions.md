# 09 - Push webhook subscriptions for Workspace Events

**What to build:** A Workspace can subscribe HTTPS endpoints to Workspace Event types and receive each event as a signed POST, in order, at least once, with the same Standard Webhooks signatures and signing secret as Completion Callbacks.

**Blocked by:** [02 - Workspace Event feed](02-workspace-event-feed.md).

**Status:** done

## Behavior

- Model `WebhookSubscription`:
  - `workspaceId`, sealed URL, `urlHost`, `urlFingerprint`, and event `types`.
  - `status` (`active`, `disabled`), `lastDeliveredSeq`, `consecutiveFailures`, `disabledReason`, `createdByUserId`.
  - The URL is sealed exactly as Completion Callback URLs are, and validated with `assertCompletionCallbackUrl`.
  - Creating one needs the Workspace's callback signing secret (refuse with `callback_secret_required`, as callbacks do).
- Delivery:
  - A worker loop claims a subscription with a lease and reads events after `lastDeliveredSeq` that match its types.
  - It POSTs them one at a time through the existing pinned `guardedFetch` delivery and signing code (reuse, don't copy).
  - It advances the cursor only on 2xx and retries with the callback backoff.
  - After 20 consecutive failures, or when the cursor falls behind 30-day retention, the subscription is disabled with a reason and the creator is notified.
  - Payload: `{ id, seq, type, version, occurredAt, workspaceId, subject }`, with the event `id` as the Standard Webhooks message ID.
- REST:
  - `POST`, `GET`, and `DELETE /api/v1/webhooks`.
  - `POST /api/v1/webhooks/{id}/enable` re-enables a subscription and resumes from where it stopped.
  - `POST /api/v1/webhooks/{id}/test` sends a `webhook.test` event.
  - Add commands with `processing.consume` and the `processing:write` scope (reads with `projects:read`), and update the parity test.
- Settings, then API, gets a Webhooks section with list, add, delete, re-enable, and recent delivery status.
- Docs: a webhooks guide (verification with Standard Webhooks libraries, ordering, dedupe, disable rules). Amend ADR 0014.

## Acceptance criteria

- [x] Delivery is in `seq` order per subscription, at least once, cursor advances only on success (DB test with a local HTTP server).
- [x] Disable after repeated failure; re-enable resumes (DB test).
- [x] URL validation and SSRF pinning reuse the callback path.
- [x] UI, docs, OpenAPI snapshot.
- [x] lint, typecheck, test, `test:integration-api:db` pass on the local Postgres.

## Comments

2026-10-24: implemented in a worktree, Opus-reviewed (high: stale batch leases could deliver out of order; now one subscription is claimed at a time, every POST is fenced on lease and cursor, four lanes run on a 20-second budget; plus re-enable after expiry, skipped-notice retry, creator membership, scope checks on enable and test, per-webhook test throttle). Merged into the main checkout. Verified there: biome, typecheck, `bun run test`, integration-api (webhook suite 27), workflow, social-publication, upload-session DB gates. No MCP tool for webhooks (REST and Settings only, as specified).
