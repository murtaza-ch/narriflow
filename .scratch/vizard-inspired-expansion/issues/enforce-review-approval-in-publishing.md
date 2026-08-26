# Enforce Review approval in publishing

**What to build:** Make Review approval an exact-export scheduling rule with an owner or admin override that requires a reason and leaves an audit trail.

**Blocked by:** [Deliver the Review tab, guest room, and notifications](deliver-review-room-and-notifications.md).

**Status:** ready-for-agent

**Specifications:** [Client review and approval rooms](../features/review-and-approval.md), [Publishing expansion and assisted copy](../features/publishing-expansion.md)

## Observable acceptance criteria

- [ ] Brand Profile provides a default approval rule and Review Round freezes its submitted rule.
- [ ] Publish and Calendar ask Review Service about the exact Clip Export IDs selected for Social Posts.
- [ ] Approval of an older editor revision never permits a newer export.
- [ ] Required but unapproved items are ineligible in single and bulk scheduling.
- [ ] Only `review.override` may bypass the gate, and every override requires a nonempty bounded reason.
- [ ] The override audit reference is stored with each affected Social Post or Campaign Operation item.
- [ ] Downgrade and restricted workspace behavior preserve existing audit and never silently disable a configured gate.

## Tests and failure injection

- [ ] Tests cover no review, partial approval, changes requested, campaign approval, newer export, revoked round, expired round, and resubmission.
- [ ] Role tests cover owner, admin, editor, viewer, API key, and worker principals.
- [ ] Duplicate schedule and override submissions remain idempotent.

## Rollout

- [ ] Run in warn-only mode first and compare would-block decisions.
- [ ] Enable enforcement per workspace after zero unexplained differences.

## Scope boundaries

- [ ] Do not require review for brands or projects whose frozen policy is advisory.

## Fresh-task handoff

Implement with `/tdd`, finish with `/code-review`, and run review, social, calendar, permission, typecheck, and repository tests.

