# Plan 031: Preserve and reconcile ambiguous social-publication outcomes

> **External-side-effect migration — approval required**: Build/test provider
> adapters in sandboxes or test accounts. Never replay an unknown outcome into
> a real social account during development.

## Status

- **Priority**: P1 before direct publishing launch
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: plans/027-leased-idempotent-workflows.md
- **Category**: correctness, migration, feature
- **Planned at**: commit `05d273d`, 2026-07-09, live working tree

## Why this matters

The worker publishes externally before persisting the provider post ID. If the
database write or analytics step then fails, Narriflow marks the post failed;
the user can retry and create a duplicate public post. The reaper likewise
turns abandoned `publishing` rows directly into failed without checking the
provider.

## Target state machine

Use explicit states:

`draft → scheduled → claimed → publishing → posted`

and terminal/recovery branches:

- `reconciling` / `outcome_unknown` when the provider may have accepted work;
- `retryable_failed` only when the provider definitely did not publish;
- `permanent_failed` for validated nonretryable input/auth/policy errors.

Persist an operation/idempotency key before the call and the provider operation
or post ID as soon as available. Use provider idempotency keys where supported.
Provider adapters must define: request contract, definite failure classes,
ambiguous transport classes, lookup/reconcile ability, rate limits, and delete/
edit semantics. Do not force one unsafe retry rule across TikTok, YouTube,
Instagram, LinkedIn, and X.

Reapers move expired publishing work to `reconciling`, query by operation ID or
safe fingerprint, and only retry after establishing non-publication. When a
provider cannot reconcile, require human confirmation and show the exact risk;
never auto-repost.

Core posted state and provider ID commit independently of analytics through the
outbox from Plan 027. UI exposes Post now vs Schedule, selected render format,
provider-safe failure copy, reconciliation state, and allowed action.

## Required tests

- Provider accepted + DB failure; provider timeout before/after acceptance;
  analytics outage; worker crash; webhook/status callback races.
- Reaper cannot duplicate a posted item.
- Same idempotency key across retries produces one provider operation when
  supported.
- Each provider's definite/ambiguous error map and lookup behavior.
- UI never labels `outcome_unknown` as failed or offers unsafe retry.

## Done criteria

- No catch-all error path changes a possibly posted item directly to failed.
- Provider IDs/operation keys and reconciliation attempts are auditable.
- Reapers reconcile before retry.
- Core success is independent of analytics.
- Sandbox fault-injection passes for every enabled provider.

## STOP conditions

- A provider lacks both idempotency and reconciliation and product policy for
  human confirmation is undecided.
- Test credentials/accounts are unavailable.
- The design retries a transport timeout as if it proves non-publication.

