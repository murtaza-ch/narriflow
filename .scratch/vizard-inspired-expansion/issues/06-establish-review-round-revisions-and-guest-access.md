# 06 — Establish Review Round revisions and secure guest access

**What to build:** Add immutable Review Rounds, item membership, token and passcode access, guest identity, comments, decisions, audit, and media authorization before adding the project Review tab.

**Blocked by:** [Establish Brand Profile and Visual Asset ownership](01-establish-brand-profile-and-visual-asset-ownership.md), [Extend entitlements, permissions, and program analytics](02-extend-entitlements-permissions-and-program-analytics.md), and [Establish Campaign Operation and export-bundle lifecycles](04-establish-campaign-operation-and-export-bundle-lifecycles.md).

**Status:** done

**Specification:** [Client review and approval rooms](../features/review-and-approval.md)

## Observable acceptance criteria

- [x] Review models represent rounds, immutable export items, guests, threaded comments, decisions, and audit events.
- [x] Raw 256-bit tokens are returned once, only their SHA-256 hashes persist, and passcodes use a slow password hash.
- [x] Guest identity creates a token-scoped signed HttpOnly session and never creates a workspace member.
- [x] Media URLs require a live round, valid guest session, permitted item and variant, and matching download policy.
- [x] Comments support general and timecoded scopes, bounded reply depth, owner edit window, and internal resolution.
- [x] Item and campaign decisions settle atomically and retain superseded decisions.
- [x] Newer Studio edits mark a projection as newer work without mutating the round.

## Tests and failure injection

- [x] Security tests cover token guessing, hash comparison, expiry, revocation, passcode throttling, cookie replay, cross-round IDs, and download denial.
- [x] Concurrency tests cover opposite decisions, comment edits, thread resolution, resubmission, and round-number allocation.
- [x] Storage tests prove unselected project media cannot be presigned.
- [x] Logs and analytics tests reject token, passcode, reviewer identity, comment, and URL content.

## Migration and rollout

- [x] Deploy tables and internal read projections before enabling guest routes.
- [x] Keep guest access disabled until rate limits, headers, and media authorization pass adversarial review.

## Scope boundaries

- [x] Do not add the full Review tab, email delivery, approval gate, or Studio editing here.

## Fresh-task handoff

Implement with `/tdd`, run `/security-best-practices`, finish with `/code-review`, and run database, route, storage, adversarial, typecheck, and repository tests.
