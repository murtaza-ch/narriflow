# 13 — Deliver the Review tab, guest room, and notifications

**What to build:** Add the internal Review tab and public guest room over the completed Review Round service, including send, comments, decisions, resubmission, and idempotent notifications.

**Blocked by:** [Build selection-scoped campaign actions](11-build-selection-scoped-campaign-actions.md) and [Establish Review Round revisions and secure guest access](06-establish-review-round-revisions-and-guest-access.md).

**Status:** ready-for-agent

**Specification:** [Client review and approval rooms](../features/review-and-approval.md)

## Observable acceptance criteria

- [ ] `Review` is a valid project tab and every old `?tab=` value remains stable.
- [ ] Internal users create a round from selected ready exports and configure expiry, passcode, download permission, recipients, and approval rule.
- [ ] Sent rounds are immutable and `Prepare next round` selects newer exports explicitly.
- [ ] The guest room collects identity, handles passcode, plays only submitted variants, and supports accessible comments and decisions.
- [ ] Internal users reply, resolve, reopen, revoke, resend, and inspect audit history.
- [ ] An idempotent ledger sends round, first-change-request, all-approved, and mention notifications without duplicates.
- [ ] Notification failure remains visible and retryable without changing round access.

## Tests and failure injection

- [ ] Browser tests cover internal creation, public first visit, passcode, comment timecode, request changes, approval, newer work, resubmission, revocation, and mobile layout.
- [ ] Notification tests inject provider timeout, lost success response, duplicate worker claim, and invalid recipient.
- [ ] Accessibility checks cover keyboard playback, focus return, errors, captions, contrast, and screen-reader labels.

## Rollout

- [ ] Enable internal creation for staff workspaces, then guest read, then comments and decisions, then notifications.
- [ ] Each stage can be disabled without invalidating prior rounds.

## Scope boundaries

- [ ] Do not add real-time editing, drawing annotations, attachments, or reviewer accounts.

## Fresh-task handoff

Implement with `/tdd`, finish with `/code-review`, and run route, notification, browser, accessibility, typecheck, and repository tests.
