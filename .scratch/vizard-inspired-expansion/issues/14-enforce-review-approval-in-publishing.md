# 14 — Enforce Review approval in publishing

**What to build:** Make Review approval an exact-export scheduling rule with an owner or admin override that requires a reason and leaves an audit trail.

**Blocked by:** [Deliver the Review tab, guest room, and notifications](13-deliver-review-room-and-notifications.md).

**Status:** implementation-complete — staged rollout evidence pending

**Specifications:** [Client review and approval rooms](../features/review-and-approval.md), [Publishing expansion and assisted copy](../features/publishing-expansion.md)

## Observable acceptance criteria

- [x] Brand Profile provides a default approval rule and Review Round freezes its submitted rule.
- [x] Publish and Calendar ask Review Service about the exact Clip Export IDs selected for Social Posts.
- [x] Approval of an older editor revision never permits a newer export.
- [x] Required but unapproved items are ineligible in single and bulk scheduling.
- [x] Only `review.override` may bypass the gate, and every override requires a nonempty bounded reason.
- [x] The override audit reference is stored with each affected Social Post or Campaign Operation item.
- [x] Downgrade and restricted workspace behavior preserve existing audit and never silently disable a configured gate.

## Tests and failure injection

- [x] Tests cover no review, partial approval, changes requested, campaign approval, newer export, revoked round, expired round, and resubmission.
- [x] Role tests cover owner, admin, editor, viewer, API key, and worker principals.
- [x] Duplicate schedule and override submissions remain idempotent.

## Rollout

- [ ] Run in warn-only mode first and compare would-block decisions.
- [ ] Enable enforcement per workspace after zero unexplained differences.

Warn-only and Workspace/Project enforcement cohorts are implemented and tested.
Warn-only still evaluates the exact exports, emits a bounded structured
would-block warning, permits the schedule without fabricating approval, and
never creates an override. Both items remain unchecked until a real staged
comparison records zero unexplained differences and the cohort is enabled.

Local connected-flow evidence proves that bulk scheduling reused the exact
approved revision-8 Clip Export Variant. Later B-roll replacement testing
advanced the mutable Clip document to revision 10 without changing that frozen
export or broadening its approval. A live warn-only comparison and deployed
enforcement cohort remain deliberately unclaimed.

## Scope boundaries

- [x] Do not require review for brands or projects whose frozen policy is advisory.

## Fresh-task handoff

Implement with `/tdd`, finish with `/code-review`, and run review, social, calendar, permission, typecheck, and repository tests.
