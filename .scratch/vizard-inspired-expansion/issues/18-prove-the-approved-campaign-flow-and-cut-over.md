# 18 — Prove the approved campaign flow and cut over

**What to build:** Verify the full agency journey, program analytics, migration safety, downgrade behavior, rollback, and documentation before removing rollout warnings or declaring the program complete.

**Blocked by:** [Migrate Brand Kit with Brand Template compatibility](03-migrate-brand-kit-with-template-compatibility.md), [Build selection-scoped campaign actions](11-build-selection-scoped-campaign-actions.md), [Enforce Review approval in publishing](14-enforce-review-approval-in-publishing.md), [Add assisted copy, thumbnails, and bulk scheduling](15-add-assisted-copy-thumbnails-and-bulk-scheduling.md), [Add suggestion-first Auto Censor](10-add-suggestion-first-auto-censor.md), [Expand transitions and media motion](12-expand-transitions-and-media-motion.md), [Generate and insert short video](16-generate-and-insert-short-video.md), and [Expose stable workflows through versioned API and MCP operations](17-expose-stable-workflows-through-api-and-mcp.md).

**Status:** in-progress — release gates remain open

**Specification:** [Program map](../spec.md)

## Observable acceptance criteria

- [ ] A Business workspace creates two Brand Profiles, processes a project, edits clips, applies selected brand and scene actions, prepares exports, sends a Review Round, receives change requests, resubmits, gains approval, generates copy and thumbnails, and schedules supported platforms.
- [ ] The same project uses censor, motion, generated image, and generated video edits with matching Studio preview and exported media.
- [ ] Existing projects, Brand Templates, share links, direct Instagram, Calendar, exports, API, and MCP compatibility flows still work.
- [ ] Free, Creator, Pro, Business, downgrade, pending-payment, and restricted workspaces follow the approved read and mutation rules.
- [x] Program analytics compute clips-ready to approved-and-scheduled without sensitive metadata.
- [ ] Every rollout control has a tested rollback that stops new writes and keeps existing data readable.
- [x] Operations, Review Rounds, generated jobs, bundles, assets, and notifications have reconciliation runbooks and bounded cleanup.
- [ ] `CONTEXT.md`, user-facing pricing copy, internal runbooks, and public API or MCP docs match shipped behavior.

## Local connected-flow evidence — 31 August 2026

A scoped Business QA run exercised a real OpenAI still, censor/motion/Scene
edits, a four-ratio immutable revision-8 export, Review change request and
Round 4 approval, real assisted copy, durable thumbnail/frame preparation, and
one exact approved-export Social Post that survived reload and was then
cancelled before provider delivery. All four stored outputs were downloaded and
ffprobed at their requested dimensions with H.264/AAC streams and 25.22-second
duration parity. Generated-media, Review-creation, and publishing-preparation
write-off drills preserved their existing durable reads. This does not close
the unchecked two-profile, generated-video, deployed rollout, live REST/MCP,
full plan/status matrix, social-provider delivery, or real metrics gates.

## Verification

- [x] Run focused database, migration, service, worker, provider, editor, composition, API, MCP, security, and browser suites uncached.
- [x] Run `bun run typecheck` and `bun run test`.
- [x] Run the repository lint and production build commands used by the implementation branches.
- [x] Inspect representative real-media outputs for all supported aspect ratios.
- [ ] Record baseline and post-release completion rate, revision count, publish failure, provider failure, override count, and campaign completion time.

## Scope boundaries

- [x] Do not remove supported public compatibility adapters or additive columns in this program. Obsolete pre-production dual paths still follow the repository policy and must be removed rather than preserved.
- [x] Do not expand scope to mobile, Google Drive, or a general video editor during cutover.

## Fresh-task handoff

Execute as a release-proof task with `/code-review` after all dependencies close. Do not mark the program complete while any required rollback, migration, security, browser, or real-media check remains open.
