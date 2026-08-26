# Client review and approval rooms

**Status:** implementation-ready

**Vizard references:** `New Feature: Share Your Entire Project for Preview`, 14 August 2024; `Team Workspace`, 25 July 2024.

## Outcome

An agency can submit selected exports to a client, collect timecoded feedback, track decisions, and prevent unapproved work from being scheduled. The client does not need a Narriflow account.

## Internal user experience

- Add `Review` to the project tab parser, tab list, and server-rendered project content. Preserve every current tab value.
- The Review tab shows rounds newest first with status, recipients, clip count, opened time, decision progress, newer-edit warning, and link controls.
- `Create review` starts from the current Clips selection or lets the editor select ready exports inside the Review tab.
- The creation form chooses export variants, expiry, optional passcode, download permission, recipient emails for notifications, and whether approval is required before publishing.
- A sent round cannot change membership or export revisions. `Prepare next round` copies unresolved context and selects newer exports explicitly.
- Internal users can reply, resolve threads, reopen threads, and see guest identity and audit history.

## Guest experience

- A token URL opens a Blueline public review room with project title, agency identity, clip list, decision progress, and no workspace navigation.
- On first visit, the guest provides name and email. This identity is scoped to the token and stored in an HttpOnly signed session cookie.
- If the round has a passcode, verify it before exposing metadata or media. Store only an Argon2id password hash with a per-passcode salt.
- The guest can play permitted export variants, add general or timecoded comments, reply, edit or delete their own comments within a short configurable window, approve a clip, or request changes.
- Campaign approval becomes available when every required item is approved. A new change request clears campaign approval in the same transaction.
- Download buttons appear only when the round permits them.

## Domain and state

Add:

- `ReviewRound`: project, workspace, round number, status, token hash, passcode hash, expiry, download permission, approval policy, creator, sent time, revoked time, campaign decision, and timestamps.
- `ReviewItem`: round, clip, immutable export, selected variants, display order, required flag, submitted editor revision, and current decision.
- `ReviewGuest`: round, normalized email hash for lookup, encrypted email, sanitized display name, first seen, and last seen. Only Review Service may decrypt the email for authorized display or notifications.
- `ReviewComment`: round, optional item, author kind and ID, body, optional source-relative time, parent, resolution state, edit window, and timestamps.
- `ReviewDecision`: item or campaign scope, decision, actor, reason, superseded relation, and timestamp.
- `ReviewAuditEvent`: stable event kind, internal actor or guest reference, target IDs, and timestamp. Do not store tokens, passcodes, raw IP addresses, or signed URLs.

Round status is derived from revocation, expiry, item decisions, and campaign decision. Do not maintain a second status that can drift without a tested projection.

## Revision and staleness rules

- Each Review Item points to one immutable Clip Export and its submitted editor revision.
- Later Studio edits do not change the round. The internal projection compares the current editor revision and newest export fingerprint to show `newer_work_available`.
- Prior approval remains historical evidence for what the client saw. It never approves a newer revision.
- A new round receives a new token and copies no guest session. Comments from earlier rounds remain visible internally and may be linked as context, not copied as new comments.

## Access and security

- Generate a 256-bit random token, store only SHA-256, and compare hashes in constant time.
- Rate-limit token, passcode, identity, comment, and decision endpoints. A valid token must not bypass passcode throttling.
- Use short-lived presigned media URLs only after the round, item, variant, guest session, and download policy pass authorization.
- Set `noindex`, strict referrer policy, CSP, and cache controls on review pages.
- Revoke access immediately by marking the round. Existing signed media URLs use the shortest practical lifetime.
- Sanitize comment display and bound body size, nesting depth, item count, and timecode.

## Notifications

- Send one notification when the round is sent, when a first change request arrives, when all required items become approved, and when an internal reply mentions a configured recipient.
- Use an idempotent ledger so retries do not duplicate email.
- Email links contain the raw token because the recipient needs it, but logs and database rows never do.
- Notification failure does not revoke the round. Show delivery status and allow an internal resend.

## Approval gate

- Brand Profile supplies the default. Review Round freezes the rule used for that submission.
- Scheduling asks a service for approval eligibility against the exact export revision. It does not trust a client-supplied review status.
- Owners and admins may override with a required reason. Record the actor, target exports, reason, and time.
- An override applies only to the selected exports in that scheduling operation.

## Permissions and entitlements

- Business only for round creation, guest review, approval enforcement, and audit history.
- `review.manage` creates, sends, revokes, comments, and resolves. `review.override` bypasses a publish gate.
- Internal viewers may inspect review progress if they can view the project.
- Downgrade keeps existing rounds readable to workspace members and lets guests finish an unexpired active round. It blocks new rounds and resubmissions.

## Analytics

Record sent, first open, first comment, first change request, item approval, campaign approval, resubmission, expiry, revocation, and override. Keep reviewer identity and comment content out of analytics.

## Acceptance criteria

- One round can contain several clips and variants without exposing unselected project content.
- Token guessing, expired links, revoked links, wrong passcodes, stolen guest cookies, and cross-round object IDs fail closed.
- A comment timecode maps to the reviewed export and remains valid after later Studio edits.
- A newer export never inherits approval from an older round.
- Concurrent opposite decisions settle deterministically and retain an audit record.
- Approval-gated scheduling checks exact export IDs and permits only an authorized, reasoned override.
- Guest and internal flows pass keyboard, contrast, caption, and responsive checks.

## Out of scope

- Real-time cursors, simultaneous Studio editing, drawing annotations, arbitrary file attachments, legal e-signatures, or reviewer workspace membership.
- Editing the reviewed video inside the public room.
