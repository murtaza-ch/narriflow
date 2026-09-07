# Plan 030: Implement an idempotent account and media deprovisioning lifecycle

> **Destructive/legal workflow — owner approval required**: Confirm retention,
> billing cancellation, legal hold, audit-tombstone, and recovery policies
> before implementing or changing the public privacy promise.

## Status

- **Priority**: P1 release/legal blocker
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: plans/027-leased-idempotent-workflows.md
- **Category**: security, migration, compliance
- **Planned at**: commit `05d273d`, 2026-07-09, live working tree

## Why this matters

The privacy page promises account/project deletion removes media and derived
data, but Clerk `user.deleted` only sets `User.deletedAt`. Due Autopilot rules,
queued workflows, and scheduled social posts do not exclude deleted owners;
OAuth tokens, database rows, R2 objects, and provider actions can continue.

## Target lifecycle

1. **Quiesce immediately** in the webhook transaction: mark user
   deprovisioning, revoke application sessions, disable rules/social accounts,
   cancel pending workflows/posts, and prevent every claimant/query from acting
   for that owner. This step is retryable and completes before returning success.
2. **Revoke external access**: revoke/expire provider tokens where APIs support
   it and apply the approved Stripe cancellation/end-of-period policy. Keep
   ambiguous failures visible for retry; never log token values.
3. **Delete storage deterministically** from known DB keys (source, renders,
   dubs, captions, logos, temporary multipart uploads). Abort active multipart
   sessions. Record per-key checkpoints so retries do not restart blindly.
4. **Delete/anonymize data** according to retention and legal policy. Preserve
   only a minimal non-identifying tombstone/event dedupe record if approved.
5. **Complete and report** with user-facing request state, completion time, and
   support path. Project deletion uses the same saga scoped to one project.

Use an outbox/saga with deterministic step keys, attempt/backoff, and an admin
repair view. Every service lookup/claim must exclude deleted/deprovisioning
owners by construction, with shared helpers and negative tests.

## Required tests

- Deleted owner can never be claimed for ingest/STT/render/dub/autopilot/social.
- Crash after every step resumes without duplicate provider calls or missed R2
  keys.
- Shared brand-logo reference safety: deletion never removes an object still
  referenced by another authorized template.
- Active multipart uploads abort and abandoned projects clean up.
- Cross-tenant and legal-hold cases.
- Privacy page wording matches verified behavior and provides a real contact.

## Done criteria

- Public deletion promise and actual lifecycle match.
- Quiescing is immediate and enforced across all claim paths.
- R2/provider/DB steps are idempotent, checkpointed, observable, and repairable.
- No sensitive payload is stored in logs/audit tombstones.
- Production dry-run inventory and restore/rollback plan are approved.

## STOP conditions

- Retention, Stripe, or legal-hold policy is undecided.
- Storage ownership/shared-reference rules are ambiguous.
- The workflow would hard-delete before quiescing external actions.
- Production data/storage mutation lacks explicit owner authorization and backup.

