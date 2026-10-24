# 08 - Standing grants for unattended delivery

**What to build:** A Workspace Owner or Admin can grant standing authority for one Autopilot rule's output to go out without a click. Either its proposals are accepted into a Social Account's queue, or its finished exports are sent as a Review Round to a named reviewer list. Every grant has caps, an expiry, a pause, and an audit trail.

**Blocked by:** [05 - Publishing Queue](05-publishing-queue.md).

**Status:** done

**Map:** [Automation and integrations map](../map.md), "Standing grant" under New concepts, and owner direction 2026-10-24.

## Behavior

- Model `StandingGrant`:
  - `workspaceId`, `kind` (`publish` or `review_send`), `autopilotRuleId`.
  - `socialAccountId` (publish) or a reviewer email list (review_send).
  - `dailyCap`, `weeklyCap`, `expiresAt` (at most 90 days ahead), `status` (`active`, `paused`, `expired`, `revoked`), `pausedReason`, `revision`, `grantedByUserId`, timestamps.
  - Only Owners and Admins create, renew, pause, or revoke grants, using the capability that only they hold. Members can see them.
- TikTok accounts can't hold a publish grant. TikTok requires the creator's choices on every post.
- Publish grant: when finishing proposes a post (ticket 05) for a rule and account with an active grant, the post is accepted into the next free slot in the same transaction, if:
  - caps allow, checked under the account lock;
  - the Brand Profile approval gate passes. An `approval_required` brand needs an approved Review Round for that export, and otherwise the post stays a proposal.
  The Social Post records the grant ID and revision as its approval evidence.
- Review-send grant: finishing gains `delivery: "send_review_round"`. When finishing ends `ready`, it creates and sends a Review Round with the finished exports to the grant's reviewers, through the existing review service. This needs the `review.rooms` feature; below it, the step is skipped with a reason. Caps count rounds.
- Any `failed` or `needs_attention` outcome on a grant-accepted post pauses that grant with the reason and notifies the granter. A maintenance loop expires grants. Renewing bumps the revision.
- Events: `grant.paused` and `grant.expired`.
- UI: Settings, then Automation grants. It lists grants with caps, usage this day and week, expiry, status, and history (posts and rounds sent under each), with create, renew, pause, and revoke actions. The Autopilot rule page shows which grants cover it.
- Docs page explaining grants, caps, and what they never override.

## Acceptance criteria

- [x] Grants can't be created for TikTok accounts or by Members (DB tests).
- [x] Proposals under an active grant are accepted into slots within caps; over cap they stay proposals (DB test).
- [x] `approval_required` brands still need an approved round (DB test).
- [x] A failed grant-accepted post pauses the grant (DB test).
- [x] Review-send grant sends one round per finished generation, within caps, and skips below Business (DB test).
- [x] UI and docs.
- [x] lint, typecheck, test, `test:social-publication:db`, `test:workflow:db`, and the review DB gate pass on the local Postgres.

## Comments

2026-10-24: implemented in a worktree, Opus security-reviewed. Fixes: coverage is the finishing's own `autopilotRuleId`, never the Project's importer; a rule fingerprint (contract `standing-grant-rule-v2`: feed URL, title prefix, recipeId, Recipe `contentRevision`, resolved Brand Profile id with its `approvalRule` and deleted flag) is checked at delivery, and rule or Recipe content edits pause covering grants eagerly; a paused grant holds its posts at claim; revoke, expiry, rule deletion and account disconnect return unstarted posts to the inbox; rule-then-grant lock order; demoting or removing the granter pauses; pause emails leased and retried; reviewer opt-out link (`/review/opt-out`, POST to confirm). ADR 0016. Merged into dev after 12; verified: biome, typecheck, `bun run test`, worker (696), every DB gate on the local Postgres (social-publication 110). Not covered: a Brand Profile `approvalRule` change pauses only at the next delivery or rule edit, not eagerly. UI not viewed in a real browser.
