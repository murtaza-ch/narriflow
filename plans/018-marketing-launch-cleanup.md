# Plan 018: Marketing surface launch cleanup — honest hero, no placeholders, blog fix, doc sync

> **Executor instructions**: Follow step by step. Run every verification command
> and confirm the expected result before the next step. Touch only in-scope
> files. On any STOP condition, stop and report — do not improvise.
>
> **Drift check (run first)**: excerpts taken from disk on 2026-07-07
> (uncommitted working tree). If an excerpt doesn't match the live file, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW (marketing pages only; no app logic)
- **Depends on**: none (assumes plan 016's decision: watermark + 720p apply to
  the `free` tier only; all paid tiers export 1080p with no watermark)
- **Category**: ux / direction / docs
- **Planned at**: commit `05d273d` (working tree, 2026-07-07)

## Why this matters

The marketing surface — the first thing a paying customer sees — currently
ships three credibility problems:
1. The landing page shows a literal empty box labeled "Product screenshot",
   four blank avatar circles, and the unverifiable claim "Trusted by creators
   worldwide" (`apps/web/app/(marketing)/page.tsx:69-107`).
2. The hero headline promises "clips, carousels, threads, and newsletters" —
   carousels and newsletters are NOT built (the shipped content suite produces
   blog posts, X threads, LinkedIn posts, show notes and quote cards per
   ROADMAP.md §2). Over-promising in the hero invites refunds and bad reviews.
3. The footer links to `/blog`, but there is no blog index route (the `blog/`
   directory contains only `[slug]/`, so `/blog` 404s) and any slug renders a
   stub that literally says "CMS integration placeholder for marketing
   content" (`apps/web/app/(marketing)/blog/[slug]/page.tsx:19-21`).

Also: the ROADMAP §5 pricing table documents 3 tiers while the code ships 4
(`starter` at $7/300min exists in `packages/validators/src/pricing.ts:75` and
on the pricing page) — the doc must catch up so future decisions aren't made
against a stale model.

## Current state

- `apps/web/app/(marketing)/page.tsx` — full current hero (read it; 111 lines).
  Key regions:
  - Headline (lines 36-45): `Turn one long-form recording into clips, carousels, threads, and newsletters.`
  - Social proof (lines 69-87): 4 empty circles + "Trusted by creators worldwide".
  - Screenshot placeholder (lines 89-107): bordered 16:9 `Box` containing only
    `<Text fontSize="13px" color="fg.subtle">Product screenshot</Text>`.
- `apps/web/app/(marketing)/layout.tsx:49` — footer link:
  `<Link href="/blog"><Text ...>Blog</Text></Link>`.
- `apps/web/app/(marketing)/blog/[slug]/page.tsx` — 24-line stub rendering the
  slug as a title plus the placeholder sentence. No index page exists
  (`ls "apps/web/app/(marketing)/blog/"` → `[slug]` only).
- `apps/web/app/(marketing)/pricing/page.tsx` — tiers render from
  `PRICING_TABLE` (starter/creator/pro) with a `FEATURES` map (lines 13-29):
  starter: 300 min, "1080p exports", "Caption presets and brand templates";
  creator: 600 min, "No watermark", "Content-suite repurposing";
  pro: 1800 min, "Longer uploads up to 3 hours", "Pro-ready automation headroom".
  Free-plan strip at lines 130-137 says "with watermark and 720p testing exports".
- What is actually true in the product (post plans 016/017): free = watermark +
  720p; ALL paid tiers = 1080p, no watermark; content suite = Creator+;
  dubbing = Pro; upload caps = 30m/60m/90m/3h (free/starter/creator/pro, from
  `MAX_UPLOAD_LENGTH_SECONDS` in `packages/validators/src/pricing.ts:25-30`).
- Shipped feature set to sell honestly (ROADMAP.md §2 "Shipped & verified"):
  AI clip detection with virality scoring, word-synced WYSIWYG caption editor
  (preview == export), 12 caption presets + emoji captions, all four aspect
  ratios (9:16, 1:1, 16:9, 4:5), auto-reframe speaker tracking, stock B-roll,
  audiograms, brand templates, content-suite repurposing (blog/X/LinkedIn/show
  notes/quote cards), voiceover dubbing, direct social publishing + scheduling,
  RSS autopilot, transcript export.
- Design system: Chakra UI v3 with semantic tokens (`fg`, `fg.muted`,
  `bg.panel`, `accent.solid`, `border`) — matching usage visible throughout the
  three files above. Buttons come from `@narriflow/ui/components/button`.
- ROADMAP.md §5 (lines ~146-163) — the 3-tier pricing table to update.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0, 10/10 |
| Tests | `bun run test` | all pass |
| Lint | `bunx @biomejs/biome check .` | exit 0 |

## Suggested executor toolkit

- If the `frontend-design` skill is available in your environment, invoke it
  before Step 2 (the hero product visual) — the goal is a distinctive,
  professional section, not a generic AI-looking box.

## Scope

**In scope**:
- `apps/web/app/(marketing)/page.tsx`
- `apps/web/app/(marketing)/layout.tsx` (footer Blog link only)
- `apps/web/app/(marketing)/blog/[slug]/page.tsx`
- `apps/web/app/(marketing)/pricing/page.tsx` (copy only)
- `ROADMAP.md` (§5 pricing table + a one-line note in §2 if needed)

**Out of scope**:
- Any `(app)` route, component, or API code.
- The billing UI (`/settings/billing`) — separate surface.
- Adding a real CMS/blog engine; adding testimonial data you don't have.
- `packages/validators/src/pricing.ts` (prices/limits are source of truth — do
  not touch).

## Git workflow

Do NOT commit, branch, stash, or push. Edit the working tree directly and leave
changes uncommitted.

## Steps

### Step 1: Honest hero copy

In `page.tsx`: change the headline to sell what exists, e.g.
"Turn one long-form recording into viral clips, threads, and blog posts." and
keep/adjust the subtitle to name the real pipeline (ingest → transcription →
moment detection → captioned renders → publishing). Remove "carousels" and
"newsletters" everywhere on this page.

**Verify**: `grep -in "carousel\|newsletter" "apps/web/app/(marketing)/page.tsx"` → 0 matches.

### Step 2: Replace the fake social proof + screenshot placeholder

- Delete the 4-blank-avatars + "Trusted by creators worldwide" block entirely
  (no invented testimonials). In its place (or nearby) render an honest signal
  strip, e.g. three small inline stats/feature chips: "Word-accurate captions —
  preview = export", "9:16 · 1:1 · 16:9 · 4:5", "Virality-scored clips".
- Replace the "Product screenshot" box with a **code-built product visual**: a
  stylized, non-interactive mock of the studio editor composed with Chakra
  primitives inside the same 16:9 container — e.g. a dark editor frame with a
  vertical video canvas showing 2–3 caption words (one highlighted), a slim
  transcript column, and a timeline bar. Pure presentational JSX, no new deps,
  no images, `aria-hidden="true"`. Keep it subtle and professional — this must
  read as a product glimpse, not a cartoon.
- Below the hero, add a compact feature grid (3×2 max) drawn from the shipped
  list in Current state, each item: icon (lucide-react, already used in the
  codebase), 3–5 word title, one-line description. No feature that isn't
  shipped.

**Verify**: `grep -n "Product screenshot\|Trusted by creators" "apps/web/app/(marketing)/page.tsx"` → 0 matches; `bun run typecheck` → exit 0.

### Step 3: Fix the blog dead-end

- `layout.tsx`: remove the Blog footer link (keep the footer layout intact).
- `blog/[slug]/page.tsx`: replace the placeholder body with
  `import { notFound } from "next/navigation";` and call `notFound()` so any
  direct/bookmarked blog URL renders the 404 page instead of a stub. Keep the
  file (deleting the route also works, but keeping it with `notFound()` is the
  smaller diff — either is acceptable; say which you did).

**Verify**: `grep -rn "CMS integration placeholder" apps/web` → 0 matches; `grep -n 'href="/blog"' "apps/web/app/(marketing)/layout.tsx"` → 0 matches.

### Step 4: Pricing copy truthfulness pass

In `pricing/page.tsx` FEATURES map (copy only — no structure changes):
- starter: add "No watermark" (true after plan 016; all paid tiers are
  watermark-free), keep "1080p exports", keep presets/brand templates line,
  and add "Uploads up to 60 minutes".
- creator: keep "No watermark" out OR keep for emphasis — instead differentiate:
  "600 processing minutes / month", "Content-suite repurposing (blog, X,
  LinkedIn, show notes)", "Uploads up to 90 minutes".
- pro: "1,800 processing minutes / month", "Voiceover dubbing", "Uploads up to
  3 hours".
Keep the free-plan strip copy as-is (it is now true). Do not change prices or
`PAID_TIERS`.

**Verify**: `grep -n "Voiceover dubbing" "apps/web/app/(marketing)/pricing/page.tsx"` → 1 match (pro tier); visual sanity: file still typechecks.

### Step 5: Sync ROADMAP §5 to the shipped 4-tier model

Update the ROADMAP.md §5 table to four columns of tiers (Free / Starter /
Creator / Pro) using the code's source of truth
(`packages/validators/src/pricing.ts`): minutes 60/300/600/1800; monthly
$0/$7/$12/$24; annual effective $0/$5/$8/$16 (annualUsd 60/96/192 ÷ 12);
watermark Yes/No/No/No; quality 720p/1080p/1080p/1080p(+4K opt. later); max
upload 30m/60m/90m/3h. Add one sentence noting dubbing is Pro-gated and
content-suite is Creator+-gated (per plan 017). Keep the rest of §5 intact.

**Verify**: `grep -n "Starter" ROADMAP.md` → ≥1 match in §5.

## Test plan

- No unit tests for marketing copy. Gate: `bun run typecheck`,
  `bun run test`, `bunx @biomejs/biome check .` all exit 0, plus the greps above.
- Optional if a dev server is trivially available: load `/` and `/pricing` and
  confirm no layout overflow at 375px width (both pages use responsive Chakra
  props already — preserve them).

## Done criteria

- [ ] `bun run typecheck`, `bun run test`, `bunx @biomejs/biome check .` all exit 0
- [ ] Zero matches: "Product screenshot", "Trusted by creators", "carousel",
      "newsletter", "CMS integration placeholder" under `apps/web/app/(marketing)`
- [ ] Footer has no `/blog` link; `/blog/<anything>` returns 404 (notFound)
- [ ] Pricing FEATURES mention watermark-free on starter and dubbing on pro
- [ ] ROADMAP.md §5 shows the 4-tier table
- [ ] Only in-scope files modified (`git status --short`)

## STOP conditions

- The excerpts don't match the live files (drift).
- The hero visual requires a new dependency or an image asset — build it with
  existing Chakra primitives only; if that's impossible, STOP and report.
- Anything in Step 4 contradicts what plans 016/017 actually landed (check
  `plans/README.md` status column) — report instead of guessing.

## Maintenance notes

- When real customer logos/testimonials exist, they replace the honest-signal
  strip — never fake them.
- When a real blog ships, restore the footer link and replace `notFound()`.
- The product-visual mock imitates the studio; if the studio's look changes
  materially, refresh the mock (it's decorative, so drift is cosmetic).
