# Plan 025: Optimize for usable clip yield, not generated clip count

> **Decision-gated direction plan**: Do not implement until the product owner
> approves this as the next product bet and confirms the initial ICP (solo
> creators, podcast teams, or agencies). After approval, execute the phases in
> order and keep the first release deterministic; do not train or fine-tune a
> model before enough real feedback exists.
>
> **Drift check**:
> `git diff --stat 05d273d..HEAD -- packages/db/prisma/schema.prisma packages/services/src/clip.service.ts packages/services/src/analytics.service.ts 'apps/web/app/(app)/projects/[projectId]/clip-card.tsx' 'apps/web/app/(app)/projects/[projectId]/analytics-panel.tsx' apps/worker/src/tasks/detect-clips.ts`

## Status

- **Priority**: P1 product bet
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans/024-multilingual-foundation.md and Phase 1 of
  plans/042-versioned-language-terminology-profiles.md
- **Category**: direction, feature, data
- **Planned at**: commit `05d273d`, 2026-07-09, live working tree

## Why this matters

Clipping, B-roll, captions, reframing, scheduling, and translation are now
table stakes across OpusClip, Vizard, Quso, and adjacent tools. The recurring
market complaint is not “generate more clips”; it is “I reviewed 20–30 clips
and only two were usable,” followed by manual subtitle, framing, and boundary
repair. Narriflow should win on **usable yield and review time**: fewer,
better-ranked candidates, transparent quality risks, and learning from what a
workspace actually accepts, edits, publishes, and rejects.

Evidence:

- Current competitor capabilities/pricing:
  `https://www.opus.pro/pricing`, `https://vizard.ai/pricing/`,
  `https://helpdesk.quso.ai/help/subscription-plans`.
- Current user pain: `https://www.g2.com/products/opusclip/reviews` and recent
  creator discussions about high review cost and generic output.
- Narriflow's Notion competitor page already recommends “quality over
  automation” and human review:
  `https://app.notion.com/p/2e0606538ae3810da751e1c49d34943d`.

## Current state

- `Clip` stores one status (`detected/accepted/rejected/edited`), virality and
  component scores, reasoning, model, and timestamps, but no feedback reason,
  reviewer, review latency, quality flags, or before/after edit delta.
- `clip.service.ts:updateClipStatus` overwrites status only.
- `clip-card.tsx` exposes Accept/Reject and boundary/title/studio edits but does
  not ask what was wrong or measure the repair required.
- Analytics reports operational counts (renders, downloads, dubs, schedules,
  posts), not candidate yield, review time, or score calibration.
- The detector optimizes a generic prompt and heuristic score; workspace
  outcomes never feed ranking.
- Detection settings cover duration/count/platform and optional moments, but no
  reusable editorial brief defines audience, campaign goal, content pillars,
  required/forbidden topics, CTA, speaker preference, context policy, or whether
  non-contiguous narrative stitching is allowed.
- Candidate review starts from generated clips rather than a transcript-first
  skim with expandable source context. This makes incomplete thoughts expensive
  to recognize and repair.

## Product outcome and non-goals

Primary outcome: increase the percentage of presented candidates that a user
publishes with little or no repair, while reducing review minutes per usable
clip.

Non-goals for V1:

- Do not promise that a virality score predicts views.
- Do not auto-publish based only on a model score.
- Do not train on one customer's content for another customer.
- Do not hide why a candidate was down-ranked or rejected.

## Phase 0: Capture editorial intent and make source context cheap

Before generating candidates, let the user choose or edit a versioned editorial
brief containing:

- target audience and campaign/content goal;
- content pillars, required/forbidden topics and CTA constraints;
- preferred/excluded speakers, tone and title/hook style;
- desired duration/count/platform plus minimum before/after context;
- whether non-contiguous source moments may be stitched into one narrative.

Snapshot the brief and effective language/terminology profile on every detection
run. A change affects a new run, never silently reinterprets existing candidates.

Add a transcript-first skim/review mode before expensive rendering: searchable
utterance cards, quality/context signals, audio/video preview, exact source jump,
and one-click expansion before/after the proposed range. If stitching is
enabled, show every ordered source range and transition explicitly; never imply
one continuous quote. Keep the canonical source linkage compatible with Plan
043's handoff manifest.

## Phase 1: Instrument review truth (ship first)

Add an append-only `ClipReviewEvent` model rather than overwriting evidence.
Record workspace/user, clip/run, action, timestamp, prior/new status, and a
bounded reason enum:

- wrong moment / weak hook / missing context / bad boundary
- duplicate / wrong speaker or crop / transcript-caption error
- off-brand / wrong language / good as-is / other (short optional note)

Capture edit deltas without storing duplicate media: boundary seconds changed,
title/hook/caption changed, layout/brand change, renders/download/publish after
review, source-context expansions, NLE handoff, and time from first view to
terminal decision. Keep raw notes private to the workspace and define retention
before launch. Record which editorial-brief and language-profile versions
produced the candidate.

UI: after Accept/Reject, show a fast optional reason sheet that never blocks
the action; allow undo. Add keyboard shortcuts and bulk review only after the
single-card flow is proven.

**Verification gates**:

- Migration applies to an empty and representative seeded DB.
- Replayed status requests do not duplicate the same idempotent review event.
- Tenant tests prove reviews cannot cross workspaces.
- Existing Accept/Reject remains one-click and works with JS/network retry.

## Phase 2: Add a deterministic quality gate and review queue

Compute transparent quality flags before presentation using existing data:

- incomplete opening/ending sentence, low word timing/confidence
- duplicate/near-duplicate transcript slice
- title/hook language mismatch, entity/number mismatch
- face/reframe uncertainty, missing glyph/font risk, caption overflow
- render/dub/publish prerequisite failure

Show “why this needs review” separately from the existing creative/virality
score. Default the project to a ranked review queue with three buckets:
`Ready`, `Needs a look`, `Blocked`. Every flag links to the exact repair surface.
Users can override with an auditable reason.

Do not render every low-confidence candidate before review by default. Generate
cheap transcript/source previews first and render the selected or `Ready`
subset; measure whether this lowers time/cost without hiding potentially useful
moments.

**Verification gates**:

- Golden multilingual fixtures cover English, Hindi-English, Arabic/Urdu, CJK,
  and Turkish.
- The gate never marks a clip publish-ready when a required asset failed.
- Flag precision is measured; noisy flags can be disabled independently.

## Phase 3: Workspace-specific re-ranking

After at least 20 explicit review outcomes in one workspace, derive a small,
versioned preference profile: preferred durations, categories, speakers,
platforms, pacing, title style, rejected topics, and acceptable repair cost.
Use it as bounded prompt/ranking input; do not fine-tune initially.

Expose the effective profile in plain language, let the owner edit/reset it,
and record which profile version ranked every run. Run shadow evaluation before
changing live order.

Success criteria for a rollout cohort:

- ≥25% relative increase in accepted-or-published candidates / candidates
  shown, or a statistically defensible improvement agreed before launch.
- ≥40% reduction in median review time per published clip.
- No increase in duplicate or wrong-language publication incidents.
- Users can explain and undo personalization.

Report these criteria separately by source type, language/profile version,
speaker count, content length, and editorial-brief category. A global aggregate
must not hide a weak locale or source cohort.

## Phase 4: Connect predicted quality to real outcomes

Only after reliable provider metric polling exists, compare predicted signals
with normalized watch/engagement outcomes using explicit attribution windows.
Report calibration and uncertainty; do not claim causality. This phase feeds
Plan 028's performance loop, not the first release.

Keep **usable with little repair** separate from **performed well after
publication**. The first measures Narriflow's editorial throughput; the second
depends on platform/audience/distribution variables and cannot retroactively
rewrite review truth.

## Test plan

- Unit: reason/quality schemas, idempotency keys, profile versioning, deterministic
  flag rules and ranking.
- Integration: accept/reject/edit/publish event sequence; retries; two reviewers;
  deletion/retention; tenant boundaries.
- E2E: editorial brief → transcript-first source preview/context expansion →
  review queue → repair → accept → render/handoff → publish, including failures.
- Offline eval: fixed multilingual candidate corpus with human labels, reported
  by language/profile version, source type, speaker count, and editorial brief—not
  one aggregate score.

## STOP conditions

- No agreed primary ICP and success metric.
- Editorial-brief ownership/versioning or source timebase is ambiguous.
- Fewer than 20 meaningful outcomes per profile or insufficient consent for
  storing feedback.
- A proposed metric rewards clip quantity or views without accounting for
  review cost and attribution uncertainty.
- Personalization cannot be scoped to a workspace and reset.
