# 03 - Performance sync

**What to build:** Narriflow reads view and engagement counts back from YouTube and TikTok (and Facebook Reels if the existing grant allows it) on a schedule after each post, keeps the history even when the Project is deleted, and shows it on clips, Projects, and a Workspace "What worked" view.

**Blocked by:** None. Can run alongside 01 and 02 only if it doesn't touch the same files; otherwise after them.

**Status:** done

**Map:** [Automation and integrations map](../map.md), "No performance data exists" and Performance sync verdict.

## Behavior

- Today `SocialPostMetric` is always empty: every native receipt sets `metrics: null`, and `socialService.recordMetricsForPostId` has no caller outside a test. Delete that dead method and its schema/validator if nothing else uses them.
- Replace `SocialPostMetric` with metric history that survives Project deletion and retention purge: keep `workspaceId`, `platform`, the provider post ID, the Social Post ID as a nullable reference (`SetNull`), the capture time, `apiVersion`, the counts (views, likes, comments, shares, saves where the platform reports them, plus watch time when available), and raw provider metrics as JSON. Add a frozen clip-facts snapshot taken once per published video at first capture: virality score, category, hook strength, duration, aspect ratio, platform, and posted hour in the Workspace time zone. That snapshot is what the "What worked" view groups by after Projects are gone. Pre-production policy: drop the old table rather than keep both.
- Schedule: capture at about 1 hour, 24 hours, 3 days, 7 days, and 28 days after publication, then stop. A worker loop claims due captures with a lease (follow the existing loop and claim patterns in `apps/worker/src/poll-loop.ts` and an existing claimed queue), batches IDs per account (YouTube `videos.list?part=statistics` up to 50 IDs at 1 quota unit; TikTok `POST /v2/video/query/` up to 20 IDs with `view_count,like_count,comment_count,share_count`), refreshes tokens through the existing social OAuth service, and backs off on rate limits. A revoked or expired grant marks those captures skipped with a reason; it never fails the Social Post.
- Only published videos with a verified provider post ID are captured (`PublishedSocialVideo`). TikTok inbox deliveries are captured only once a public post is verified.
- Facebook Reels: implement only if `pages_read_engagement` covers `video_insights` per Meta's current docs; otherwise leave a typed "not available" for the platform and note it. Instagram (needs a new scope and review), LinkedIn (needs a vetted API), and X (billed per read) are out of this ticket.
- Views:
  - Clip cards and the Project analytics panel (`apps/web/app/(app)/projects/[projectId]/analytics-panel.tsx`) show the latest counts per post.
  - A Workspace "What worked" view lists totals and medians grouped by category, hook strength band, duration band, platform, and posted hour, with sample sizes, and says plainly when there's too little data.
  - Follow the app's design language: no borders, soft fills, accent only for interactive state (see `packages/ui/src/theme.ts` and existing pages).
- Expose the latest counts in Social Post reads for MCP (`narriflow_get_social_publication`) and add counts to `social_post` reads only; no new write scope.

## Acceptance criteria

- [x] Dead `recordMetricsForPostId` path removed; new history table migrated; history survives Project deletion (DB test).
- [x] Capture scheduling and claiming are idempotent and lease-fenced (DB test: two workers, one capture).
- [x] YouTube and TikTok clients parse real response shapes (unit tests with recorded fixtures from the docs), batch correctly, and handle 401/403/429.
- [x] Clip-facts snapshot frozen at first capture and never rewritten.
- [x] Views render with real and empty data (browser check through a temporary `/dev-preview` route, deleted afterwards, or a fixture test).
- [x] `bun run lint`, `bun run typecheck`, `bun run test`, `test:social-publication:db` pass on the local Postgres.

## Comments

2026-10-24: implemented in a worktree, Opus-reviewed (webhook-reported IDs no longer tracked, waiting count, overdue slots collapse to the newest, compare-and-swap token refresh with `invalid_grant` mapped to `grant_expired`, per-batch failure isolation, clip facts frozen at tracking time, What worked compares 7-day captures, public videos only, YouTube quota waits for the Pacific reset), merged with 01, 06, 10. Facebook Reels insights need `read_insights` and `pages_manage_engagement`, so Facebook stays typed not-available. Verified in the main checkout: biome, typecheck, `bun run test`, and all DB gates including social-publication (47). Migration `20261024110000_performance_sync` must reach the shared database before deploy. Not viewed in a real browser yet.
