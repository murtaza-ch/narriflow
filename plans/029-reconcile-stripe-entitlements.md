# Plan 029: Reconcile Stripe subscriptions into ordered, auditable entitlements

> **Money/access migration — owner approval required**: Before implementation,
> decide the access policy for `trialing`, `past_due`, `unpaid`, `paused`, and
> canceled subscriptions, including any grace period. Test only in Stripe
> sandbox until shuffled-event and reconciliation gates pass.

## Status

- **Priority**: P1 release blocker
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: plans/027-leased-idempotent-workflows.md
- **Category**: correctness, billing, migration
- **Planned at**: commit `05d273d`, 2026-07-09, live working tree

## Why this matters

`billing.service.ts` currently overwrites `User.pricingTier` from each webhook
snapshot. Stripe explicitly does not guarantee event delivery order and can
deliver duplicates; a delayed old update can re-enable a canceled plan or a
late deletion can remove a newer subscription. The user stores only customer
ID and tier, so support cannot explain or repair entitlement history.

Official guidance: `https://docs.stripe.com/webhooks` (ordering, duplicates,
asynchronous processing) and
`https://docs.stripe.com/billing/subscriptions/webhooks` (subscription state).

## Target design

- Add a local subscription/entitlement record with customer, subscription,
  price/product, status, tier, current period, cancel-at-period-end, latest
  Stripe object timestamp/version signal, last synchronized time, and safe
  reconciliation error. Keep an append-only processed-event record with unique
  Stripe event ID.
- Atomically claim event ID, then enqueue reconciliation. Webhook verification
  and persistence return quickly; provider/API work runs asynchronously.
- Treat event payload as a notification, not final truth. Retrieve the current
  subscription/customer state for ambiguous or stale events, then derive access
  from one documented policy. If a customer can have multiple subscriptions,
  explicitly choose the highest active entitlement; never “last event wins.”
- Update user tier and subscription record in one transaction. Record why the
  tier changed and which provider object/version established it.
- Add scheduled reconciliation for active/recent subscriptions and an admin
  repair command that is idempotent and audit logged.

## Required tests

- Every permutation of created/updated/deleted/paid events yields the same
  final entitlement as current Stripe state.
- Duplicate event ID and duplicate object/type do not reapply side effects.
- Old cancellation cannot remove a newer replacement subscription.
- Past-due/grace/paused policies match the approved matrix.
- Provider timeout leaves prior entitlement plus visible reconciliation state;
  it never guesses a new tier.
- Checkout return page does not grant access before authoritative state.

## Done criteria

- No webhook directly writes tier from an unverified snapshot.
- One documented entitlement policy covers every relevant Stripe status.
- Event order/duplicate/failure tests pass.
- Billing UI shows current status, renewal/cancel date, and reconciliation issue
  without exposing provider internals.
- Sandbox reconciliation and rollback runbook are complete.

## STOP conditions

- Access/grace policy is undecided.
- Production price IDs cannot be mapped unambiguously to tier.
- The migration cannot coexist with current `User.pricingTier` during rollout.
- A live-mode event or subscription would be mutated without explicit approval.

