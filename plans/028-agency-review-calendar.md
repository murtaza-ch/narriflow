# Plan 028: Ship a content-operations inbox before agency collaboration

> **Split-scope direction plan**: Phases 1–2 serve the recommended podcast and
> recurring-content-team ICP without changing ownership. Implement Phase 3
> agency RBAC/client review only after paid demand and a workspace ownership
> migration are explicitly approved. Do not bundle the two decisions.

## Status

- **Priority**: P2 (Phase 1 can be P1 launch trust)
- **Effort**: M for owner-only operations; L for later agency scope
- **Risk**: MED
- **Depends on**: plans/027-leased-idempotent-workflows.md; reliable social
  outcome reconciliation
- **Category**: direction, feature, migration
- **Planned at**: commit `05d273d`, 2026-07-09, live working tree

## Why this matters

OpusClip, Vizard, Quso, and Repurpose offer scheduling, calendar, bulk, brand or
team workflows at paid tiers. Narriflow has brand templates, native social
accounts, per-project scheduling and Autopilot, but no cross-project ready/
review/scheduled/reconciling/failed queue. Podcast/content teams need that
operational view before they need seats, client portals or white-labeling.

## Current state

- `Team`, `TeamMember`, and `TeamInvite` exist in Prisma, but the main ownership
  model remains user/project and there is no complete invite/RBAC UI.
- Scheduling is one project/clip/account/caption at a time. Blank scheduled time
  currently means immediate eligibility even though the CTA says “Schedule.”
- The first rendered aspect ratio is chosen silently; provider constraints and
  failure reasons are not reviewable before scheduling.
- Analytics is project-local and operational; no cross-client queue, approval
  SLA, retry inbox, or audit trail exists.
- Autopilot rules cannot be edited/duplicated and hardcode important content
  settings, limiting multi-show/multilingual reuse.

## Phase 1: Make single-post intent and recovery explicit

Ship this regardless of ICP before a calendar:

- Separate `Post now` and `Schedule` modes.
- Require confirmation for immediate external publication and a valid future
  time for scheduling, in the user's configured timezone.
- Let the user select/review platform-specific render, caption, title, and
  account; show constraint violations before submit.
- Show actionable failure reason, ambiguous/reconciling state, and idempotent
  retry. Never offer retry when the provider may already have posted until
  reconciliation completes.

## Phase 2: Owner-only operations inbox and content calendar

- Calendar/list views of drafts, needs-review, approved, scheduled, publishing,
  reconciling, posted, and failed across projects/accounts.
- Store schedule timezone and immutable intended UTC instant; render in each
  viewer's timezone with explicit labels.
- Bulk reschedule/approve with per-platform validation and partial-result
  reporting.
- Filters by brand/client, platform, owner, status, and campaign.
- Provider adapter owns allowed formats, caption lengths, media constraints,
  posting windows, rate limits, and retry semantics.

Keep this phase under the current owner/user model. Reuse Plan 025's append-only
review events and Plan 031's publication states instead of introducing a second
approval model. Include readiness, review repair, schedule/reconcile/failure and
Autopilot draft queues in one list-first inbox; add calendar presentation after
state semantics are reliable.

## Phase 3: Optional team review and brand governance (separate approval)

Confirm ownership architecture before migration: workspace owns projects,
brand templates, social accounts, rules, and content—not individual users.

Roles:

- Owner/admin: billing, connections, retention, members.
- Editor: create/edit/render/schedule.
- Reviewer/client: comment, request changes, approve/reject; cannot publish or
  access credentials.

Add append-only review events, comments anchored to clip/time/asset, approval
requirements per brand, audit log, notification digest, and expiring client
review links with least privilege. Brand templates become versioned; scheduled
posts pin the approved version.

## Phase 4: Editable Autopilot and approval gates

Expose/duplicate/version existing rule fields: brand, source language,
platforms, caption preset, output types, duration, publish destinations, and
approval policy. A rule edit affects future imports only; already created work
pins its rule version. Autopilot may create drafts automatically but cannot
bypass a configured human approval gate.

## Tests and success criteria

- RBAC matrix across every route/service and cross-tenant negative tests.
- Two reviewers/race/withdraw/reapprove audit trail.
- Post-now versus scheduled semantics, DST/timezone matrix, platform format
  validation, partial bulk failure, ambiguous provider outcome.
- Rule edit/version/crash/retry tests; no duplicate projects/posts.
- Product success for Phase 2: time from ready clip to scheduled/published,
  review queue age, failed/reconciling recovery, missed schedule rate, and weekly
  active operations users. For Phase 3: approval turnaround and collaborative
  workspaces—not raw seat count.

## STOP conditions

- Phase 2 status semantics or the initial podcast/content-team ICP are undecided.
- Social provider outcome reconciliation is not shipped.
- Phase 3 is attempted before paid agency demand and workspace ownership/RBAC
  are approved and migration-tested.
- Reviewer links expose source media, tokens, or unrelated client projects.
- “Bulk” operations lack item-level status and idempotency.
