# Free-project retention and irreversible purge

**Status:** Accepted
**Decision date:** 2026-08-11
**Owners:** Product and Engineering
**Evidence:** Live Vizard free-workspace audit, repository analysis, and the external references below.

## Context

Narriflow's Free plan needs an explicit project-retention contract. The goal is to make the limit understandable before users upload content, prevent expired content from remaining accessible, and reclaim live database and Cloudflare R2 storage predictably without risking shared assets or resurrecting deleted projects during recovery.

Vizard currently gives Free projects a short retention window and communicates it in the project library. Narriflow will use that product pattern while making expiration, upgrade, downgrade, backup, and deletion behavior explicit and operationally testable.

## Accepted lifecycle decisions

| Use case | Decision |
|---|---|
| Project created on Free after activation | Deadline is exactly `createdAt + 72 hours`, calculated and persisted in UTC. |
| Project created before activation | Grandfathered permanently; no automatic deadline or retroactive backfill. |
| Paid project | No expiration. |
| Free user upgrades before the deadline | Clear deadlines from every unexpired project. |
| Upgrade occurs at or after the deadline | No recovery, even if asynchronous deletion has not completed. |
| Paid user downgrades to Free | Existing projects receive 28 days from the effective downgrade time. |
| Project created after downgrade | Uses the normal three-day Free policy. |
| Deadline reached | Access locks immediately; asynchronous irreversible purge begins. |
| Active processing | Block new claims, cancel queued work, and let running work exit at a safe checkpoint. |
| Shares and publishing | Revoke share access and cancel unpublished Narriflow social jobs; published external posts remain. |
| Project storage | Delete every object under `projects/{projectId}/`; preserve shared brand/audio assets outside that prefix. |
| Manual user deletion | Keep the existing synchronous path. Low-level storage deletion primitives may be shared. |
| Recovery | No recycle bin or user-visible restore after expiration. |
| Notifications | Show warnings in Home/Projects and send one required service email approximately 24 hours before expiration. |
| Missing verified email | Skip delivery and record the reason. |
| Legal holds | Not supported in v1. |
| Audit evidence | Keep a content-free deletion receipt for 90 days. |

## Retention policies and change control

Retention policies are versioned, typed application contracts:

- `free_project_v1`: 72 hours from project creation.
- `downgrade_to_free_v1`: 28 days from the effective downgrade event.
- Paid and grandfathered projects: no retention policy and no deadline.

The calculated `expiresAt` is persisted on each project. Runtime code must not reinterpret an existing deadline from the user's current plan. Any future duration or anchoring change creates a new policy key, such as `free_project_v2`; it must not silently rewrite projects governed by an earlier policy. Material changes require a superseding decision record.

## Access and billing contract

- A project is customer-accessible only while `expiresAt` is null or strictly greater than the current time.
- At the exact deadline, project reads, edits, exports, downloads, shares, signed URLs, social scheduling, MCP operations, and new worker claims behave as not found.
- Signed-URL lifetimes are clamped so they cannot extend beyond a persisted deadline.
- A verified upgrade effective before a deadline clears every unexpired project deadline transactionally. An upgrade effective at or after a deadline cannot restore that project.
- Access still locks at the exact deadline, but destructive work waits for a 60-second billing-settlement window. A delayed, authoritative pre-deadline upgrade may cancel a fenced purge only before any object is deleted or storage is verified empty; the purge then has an explicit point-of-no-return fence.
- A paid-to-Free transition assigns `downgrade_to_free_v1` to existing projects once. Replayed or stale billing events cannot extend a deadline.

## Purge and erasure contract

Expiration is a fenced, leased, idempotent workflow. The purger first blocks new work and cooperatively cancels current work, then deletes storage before deleting database rows:

1. Establish the purge fence and cancel queued workflows and unpublished social jobs.
2. Wait for running work to exit at a safe checkpoint or lose its lease.
3. Abort incomplete multipart uploads for the project.
4. List and delete the full `projects/{projectId}/` prefix in batches of at most 1,000 objects, repeating until empty.
5. Write a content-free deletion tombstone outside the restorable application database.
6. In one database transaction, create the deletion receipt and hard-delete the project so project-owned relations cascade.

The external tombstone contains only a hashed project identifier, policy key, deadline, completion time, and aggregate object/byte counts. It contains no title, URL, transcript, storage key, email address, or media. Database receipts and external tombstones expire after 90 days. Before traffic resumes after a database restore, the recovery procedure replays unexpired tombstones so an expired project cannot re-enter normal processing.

The live-system deletion objective is 15 minutes from the deadline. This is an operational SLO rather than a promise during a Postgres or Cloudflare outage. Failed projects remain inaccessible, retry at increasing intervals, and alert after three failed attempts or an SLO breach.

Cloudflare R2 lifecycle rules are defense-in-depth for abandoned multipart uploads and receipt cleanup, not the primary project-retention engine. A user can upgrade before a deadline, so the authoritative decision must remain transactional application state. Project media is private and delivered by signed R2 URL; no CDN invalidation is required in v1. A future public CDN must add an explicit invalidation adapter before launch.

## Product communication

- Home and Projects show a persistent Free-retention explanation, exact per-project countdowns, expiration timestamps, and an Upgrade action.
- Downgraded projects display their 28-day grace deadline.
- Project detail and Studio do not repeat the warning.
- The service email is sent once per project around 24 hours before expiration regardless of the completion-email preference.
- Pricing, onboarding, and retention/privacy copy state: **Free projects are permanently deleted three days after creation. Upgrade before the deadline to keep all active projects.**

"Permanently deleted" means removal from live Postgres and Cloudflare R2. It does not mean immediate physical destruction of every disaster-recovery backup. Customer-accessible point-in-time recovery is limited to seven days. Neon may retain provider backups for up to 30 days; erased data is not returned to normal use and disappears as those backups expire.

## Rollout and observability

The feature runs in observe-only mode for seven days. Observe mode calculates candidate deadlines and records aggregate metrics but does not persist deadlines, show warnings, email users, cancel work, or delete data. Enforcement begins at one explicit UTC activation timestamp. Only projects created after that timestamp receive `free_project_v1`; all earlier projects remain grandfathered.

Operational metrics cover candidate/due projects, warning-email outcomes, cancelled jobs, objects and bytes deleted, purge duration, retries, failures, SLO breaches, and receipt cleanup. The recovery runbook must include a tombstone replay drill.

## Alternatives rejected

- **Soft deletion or a recycle bin:** rejected because the accepted Free-plan contract is irreversible deletion.
- **Database-first deletion:** rejected because it removes the durable retry anchor before object storage is empty.
- **R2 lifecycle as the sole engine:** rejected because plan upgrades can revoke future deadlines.
- **Retroactively expiring existing Free projects:** rejected; all pre-activation projects are grandfathered.
- **Per-project “save” controls:** rejected; upgrading saves all still-active projects.
- **Completion-email preference controls the warning:** rejected; expiration warning is a required service notice.
- **Deleting shared brand/audio assets:** rejected; only the project-owned prefix is in scope.
- **Deleting already-published external posts:** rejected because they are no longer solely controlled by Narriflow.
- **Legal holds in v1:** rejected as out of scope; a future hold system requires a new policy and decision record.

## References

- [Vizard storage policy](https://help.vizard.ai/en/articles/15966025-how-to-manage-storage-in-the-vizard-workspace)
- [Cloudflare R2 object lifecycle rules](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
- [Cloudflare R2 consistency guarantees](https://developers.cloudflare.com/r2/reference/consistency/)
- [Cloudflare R2 Workers batch deletion](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [ICO right-to-erasure guidance](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/right-to-erasure/?q=backup)
- [EDPB storage-limitation guidance](https://www.edpb.europa.eu/sme/find-practical-info/faq_en?page=1&s=)
- [NIST SP 800-88 Rev. 2](https://csrc.nist.gov/pubs/sp/800/88/r2/final)
- [Neon security overview](https://neon.com/docs/security/security-overview?a=49cb2cda-206a-4493-8c21-1669b859d9b0)

## Implementation and operational links

This section is intentionally completed as implementation lands:

- Database migration: `packages/db/prisma/migrations/20260811020000_free_project_retention/migration.sql`
- Retention service and worker: `packages/services/src/project-retention.service.ts`, `apps/worker/src/index.ts`
- Home/Projects UI: `apps/web/app/(app)/projects/_components/retention-banner.tsx`
- Metrics dashboard and alerts: structured retention events implemented; external dashboard configuration remains an operations task
- Restore/tombstone replay runbook: `docs/runbooks/project-retention-restore.md`
