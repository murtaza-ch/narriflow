# 13 — Deliver the Review tab, guest room, and notifications

**What to build:** Add the internal Review tab and public guest room over the completed Review Round service, including send, comments, decisions, resubmission, and idempotent notifications.

**Blocked by:** [Build selection-scoped campaign actions](11-build-selection-scoped-campaign-actions.md) and [Establish Review Round revisions and secure guest access](06-establish-review-round-revisions-and-guest-access.md).

**Status:** implementation-complete — staged rollout evidence pending

**Specification:** [Client review and approval rooms](../features/review-and-approval.md)

## Observable acceptance criteria

- [x] `Review` is a valid project tab and every old `?tab=` value remains stable.
- [x] Internal users create a round from selected ready exports and configure expiry, passcode, download permission, recipients, and approval rule.
- [x] Sent rounds are immutable and `Prepare next round` selects newer exports explicitly.
- [x] The guest room collects identity, handles passcode, plays only submitted variants, and supports accessible comments and decisions.
- [x] Internal users reply, resolve, reopen, revoke, resend, and inspect audit history.
- [x] An idempotent ledger sends round, first-change-request, all-approved, and mention notifications without duplicates.
- [x] Notification failure remains visible and retryable without changing round access.

## Tests and failure injection

- [x] Browser tests cover internal creation, public first visit, passcode, comment timecode, request changes, approval, newer work, resubmission, revocation, and mobile layout.
- [x] Notification tests inject provider timeout, lost success response, duplicate worker claim, and invalid recipient.
- [x] Accessibility checks cover keyboard playback, focus return, errors, captions, contrast, and screen-reader labels.

## Local browser evidence — 31 August 2026

- A signed-in Business workspace sent Round 3, received a timecoded change
  request in the private guest room, then sent Round 4 with all four immutable
  revision-8 variants. Round 4 superseded Round 3 and received item plus
  campaign approval.
- Review candidates used the completed immutable-variant duration (`0:25`),
  not the shorter base clip window. The guest room exercised passcode access,
  keyboard playback, comments, decisions, internal reply, resolve/reopen, and
  audit history.
- Notification delivery failed against the deliberately unverified local
  sender domain. The durable failure stayed visible and retryable without
  affecting guest access or round state.
- With new-round creation disabled, the signed-in history and authenticated
  approved guest room remained readable while the creation form showed an
  explicit rollout pause. This is local rollback proof, not a deployed staff
  cohort.

**Remaining evidence:** Run the staged staff rollout and prove successful
delivery through a verified sender domain.

## Rollout

- [ ] Enable internal creation for staff workspaces, then guest read, then comments and decisions, then notifications.
- [x] Each stage can be disabled without invalidating prior rounds.

Creation, guest read/media, feedback mutations, and notification
admission/delivery now have independent fail-closed controls. Disposable-schema
coverage pauses each seam, preserves the same round/session/discussion/decision
rows, then re-enables the same session and notification resend. The first item
remains unchecked until the staged staff deployment is actually run.

## Scope boundaries

- [x] Do not add real-time editing, drawing annotations, attachments, or reviewer accounts.

## Fresh-task handoff

Implement with `/tdd`, finish with `/code-review`, and run route, notification, browser, accessibility, typecheck, and repository tests.
