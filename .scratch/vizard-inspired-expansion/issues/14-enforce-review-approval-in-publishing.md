# 14 — Enforce Review approval in publishing

**What to build:** Make Review approval an exact-export scheduling rule with an owner or admin override that requires a reason and leaves an audit trail.

**Blocked by:** [Deliver the Review tab, guest room, and notifications](13-deliver-review-room-and-notifications.md).

**Status:** done

**Specifications:** [Client review and approval rooms](../features/review-and-approval.md), [Publishing expansion and assisted copy](../features/publishing-expansion.md)

## Observable acceptance criteria

- [x] Brand Profile provides a default approval rule and Review Round freezes its submitted rule.
- [x] Publish and Calendar ask Review Service about the exact Clip Export IDs selected for Social Posts.
- [x] Approval of an older editor revision never permits a newer export.
- [x] Required but unapproved items are ineligible in single scheduling, and the gate evaluates multi-export batches for the bulk scheduler delivered by issue 15.
- [x] Only `review.override` may bypass the gate, and every override requires a nonempty bounded reason.
- [x] The override audit reference is stored with each affected Social Post; `CampaignOperationItem` has the same durable reference for issue 15's bulk scheduling items.
- [x] Downgrade and restricted workspace behavior preserve existing audit and never silently disable a configured gate.

## Tests and failure injection

- [x] Tests cover no review, partial approval, changes requested, campaign approval, newer export, revoked round, expired round, and resubmission.
- [x] Role tests cover owner, admin, editor, viewer, API key, and worker principals.
- [x] Duplicate schedule and override submissions remain idempotent.

## Rollout

- [x] Run in warn-only mode first and compare would-block decisions.
- [x] Enable enforcement per workspace after zero unexplained differences.

## Scope boundaries

- [x] Do not require review for brands or projects whose frozen policy is advisory.

## Fresh-task handoff

Implement with `/tdd`, finish with `/code-review`, and run review, social, calendar, permission, typecheck, and repository tests.
