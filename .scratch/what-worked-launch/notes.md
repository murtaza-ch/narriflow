# What worked: before it reaches users

**Status:** open. Written 2026-10-28, after the page redesign.

**Feature:** the `/performance` page ("What worked") and the Performance Guidance it feeds into clip picking. Built in [03 - Performance sync](../automation/issues/03-performance-sync.md) and [13 - Performance guidance](../automation/issues/13-performance-guidance.md). Both tickets are marked done, but only on unit, fixture and DB tests.

## What we know today

- **It has never run on real data.** On 2026-10-28 the shared dev database (`narriflow-dev` / `deployed-dev`) held 0 `PublishedSocialVideo`, 0 `TrackedVideo`, 0 `PerformanceCapture` and 0 `PerformanceGuidance` rows. No clip has been published, tracked or measured end to end.
- **The data views have never been seen in a browser.** Ticket 03 says "Not viewed in a real browser yet". The 2026-10-28 redesign was checked on screen only in the empty state; the tables, lift bars, progress meters and "How this is measured and used" panel are covered by `what-worked.test.tsx` only.
- **The redesign fixed one server render crash.** `chakra.img`, `chakra.svg` and `chakra.details` are undefined inside a server component, and the unit tests can't catch that because they don't render as server components. The page now uses `Box as=...`, `Image` and a plain `<svg>`. Any future server page has the same trap.

## Must do before launch

- [ ] **Run one real loop end to end.**
  - Connect a YouTube and a TikTok account.
  - Publish a public clip from Narriflow.
  - Confirm a `TrackedVideo` row and its captures at about 1 hour, 24 hours, 3 days, 7 days and 28 days.
  - Confirm the 7-day reading appears on the page.
  - Repeat with the Railway `dev` worker. The `performance_sync` loop runs every 60 s by default (`PERFORMANCE_SYNC_POLL_INTERVAL_MS`), and guidance recomputes every 15 min (`PERFORMANCE_GUIDANCE_POLL_INTERVAL_MS`).
- [ ] **Get the provider approvals.**
  - TikTok: `video.list` needs TikTok app review before production users can grant it.
  - YouTube: `youtube.readonly` is a sensitive scope, so it needs Google OAuth verification. Size the quota too: `videos.list` costs 1 unit per 50 IDs, out of the default 10,000 units a day.
  - Until both are approved, real users can't be measured.
- [ ] **Check the data views on screen.** Use a temporary `/dev-preview` route with fixture data (delete it afterwards) and capture these states in light and dark mode:
  - too little data
  - waiting videos
  - full tables
  - guidance on
  - guidance off
  - guidance not yet qualifying
- [ ] **Decide the guidance default (owner).** `Workspace.usePerformanceGuidance` is null for every Workspace, and null counts as on (`packages/services/src/performance-guidance.ts:315`). Every Workspace is opted in to clip picking from its own performance data unless someone turns it off. Confirm this is wanted, and say so in onboarding or settings copy.
- [ ] **Confirm plan gating (owner).** The nav item and page have no plan feature, so every plan sees What worked. Decide whether that's intended.
- [ ] **Write the docs page.** `apps/web/content/docs` has no page for What worked or Performance Guidance. The page's "How this is measured and used" text should link to it.

## Should do soon after

- [ ] **Shorten the first wait.** A new user waits at least 7 days for anything on the page, but captures already exist at 1 hour, 24 hours and 3 days. Consider showing "early readings" that are marked as not comparable yet.
- [ ] **Show clips, not only groups.** A "top clips" list with thumbnails and their 7-day views (the sample preview already shows the shape) would make the page useful before group comparisons are.
- [ ] **Add the other platforms.**
  - Facebook Reels needs `read_insights` and `pages_manage_engagement`, which means Meta review.
  - Instagram needs an insights scope and review.
  - LinkedIn has no vetted API.
  - X charges per read.
  - The page already shows these as "Not yet".
- [ ] **Cover privacy.** Captures keep the raw provider JSON. `TrackedVideo` survives Project deletion by design and is deleted with its Workspace (`onDelete: Cascade`). Cover both in the privacy policy and the data-deletion docs.

## Done in the 2026-10-28 redesign

- Empty state: three numbered steps, the next action, and a labelled sample preview (top clip, 7-day curve, category bars).
- Platform coverage shown as logos (Measured / Not yet), with one hint about the 7-day comparison.
- Data state: stat tiles with icons, progress toward the minimum sample, inline bars in the group tables, lift bars around 1x, and the long explanations folded into a disclosure.
- Copy cut throughout. Every behavior the tests check is still stated.
