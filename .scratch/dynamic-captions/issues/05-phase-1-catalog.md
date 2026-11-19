# 05 - Phase 1 catalog

**What to build:** Editorial, Cutout, Marker and Stack ship with tiles, left alignment, `slam` and `drop` (spec section 6 catalog).

**Blocked by:** 03b, 03c

**Status:** claimed (built and verified; waits only on Sol's visual review)

Spec: [../spec.md](../spec.md). Follow the spec; where a ticket and the spec disagree, the spec wins.

## Acceptance

- [x] The four styles with the catalog values; tiles; left alignment with RTL mirroring; `drop`, `slam`, `rotateZDeg`.
- [x] Fixture cases and frames for each style; MCP preview cards, brand kit forms and previews, a docs page showing the styles.
- [ ] Sol visual review recorded under `## Comments`.
- [x] `bun run lint`, `bun run typecheck`, `bun run test` pass (Bun 1.4.4). No PostgreSQL or heavy suites.

## Comments

### Opus, 2026-11-19: phase 1 catalog built

Not committed. Sol's visual review is the only open box.

**What changed**

- `packages/validators`: `CAPTION_DYNAMIC_STYLES` gains Editorial, Cutout, Marker and Stack; catalog presets `editorial`, `cutout`, `marker`, `stack` in the Dynamic group after Headline (29 presets). Motions `slam` and `drop` (spec 5.7 table; both dynamic-only). Style fields added: `emphasis: "never"` (no hero; the plan and the samples score with `policy: "never"`), `tile.gapEm` and `tile.shadowEm`, `softShadow` is now a list of layers (`CaptionSoftShadowLayer[]`), and `CaptionRoleType.colour` may be a literal hex (a style constant, like `tile.fill`). `captionRoleLook` returns `tileColor`.
- `packages/caption-fonts/src/caption-block.ts`: tile geometry (`PlacedWord.tile`: centre, size, radius, shadow offset; the tile spans the advance plus `padXEm` per side and the row's ink plus `padYEm`, so a row's tiles share a height), the tile gap replaces the word gap for tile styles, and `PlacedWord.scaleOriginX/Y` from the new optional `MeasuredWord.boxMiddleEm`. Reserved bounds now hold each turned tile and its shadow, and scale about each element's own scale origin.
- Worker (`caption-ass.ts`, `caption-block-geometry.ts`): each tile is a `\p1` rounded rectangle on layer 0 with the word's `\org`, `\frz` and motion tags (`\move`, `\fade`, `\t`); every hard shadow is written before every tile. One shadow event per soft shadow layer. `boxMiddleEm` = (ascent − descent) / 2 of the word's faces, the point libass scales an `\an5` event about (measured: `\fscx150` grows "pop" exactly about `\pos`).
- Studio (`caption-block-painter.tsx`, `caption-block-pose.ts`): tile and tile-shadow elements sharing the word's transform origin and pose; each element scales about its own origin (`rotate translate translate(o) scale translate(−o)`), which also settles 05b finding 3 for every scaling motion; one element per soft shadow layer.
- Plan: `withCaptionBlocks` uses the style's `emphasis` policy. Fixtures: `editorial-en`, `cutout-en`, `cutout-long-word-fit`, `marker-en`, `marker-urdu`, `stack-en`, `stack-slam` (16 cases now).
- Real-libass test (`caption-block-render.test.ts`): scaled and turned words are compared in their rest frame (`restBox` takes every ink pixel back through the shared pose: unturn about the word centre, untravel, unscale about the scale origin), tiles are checked the same way, a +33 ms moment is added for motions that scale or turn, and `restBox` has its own synthetic test. The fast ASS test knows tile and multi-layer shadow events.
- Everywhere a preset appears: REST snapshot and public OpenAPI regenerated (4 ids each), preset backdrops (`editorial` lamp-study, `cutout` pastel-room, `marker` bright-room, `stack` dark-studio), sample cue (Cutout keeps no hero; test over every Dynamic preset), MCP upload card test (every Dynamic style shows its catalog name; the card already labels one-word ids correctly, so no rebuild of `app-script.ts`), docs page `apps/web/content/docs/caption-styles.mdx` with five worker frames in `public/docs/caption-styles/`, listed first under Guides > Features. Docs images were the first in any page: the MDX build hands `ZoomImage` a static import object, so `zoom-image.tsx` now takes `src.src`. Caption-parity page takes `&bg=dark|bright|busy`. Brand kit forms and previews list the presets from `CAPTION_PRESETS` and draw them through the shared painter, so they needed no change of their own.

**Values chosen and deviations from the catalog**

| Style | Catalog | Built | Why |
| --- | --- | --- | --- |
| Headline | shadow black 65%, 6 px blur, 2 px down | black 85%, sigma 0.075 em (CSS 12 px at S = 80), 0.03 em down | legibility pass below |
| Editorial | minor Inter SemiBold 40, body Instrument Serif 60, hero 144 lowercase, stagger 8 px, rowGap 0.10, `blur` | as catalog; body words sit on the hero font slot (Instrument Serif, lowercase), minor words on the text slot (`fontName` Inter SemiBold, preset `textTransform` lowercase); noHeroSizeEm 1.4; two-layer shadow | the role model has two face slots; the catalog gives no no-hero size or shadow |
| Cutout | Bebas caps S = 84, tiles, tilts −2 1.5 −1 2, hard shadow 3 px, `drop`, 5 words | as catalog; body ink = `primaryColor` #F5923E, minor ink literal #16161A, body tile literal #16161A, minor tile = accent #F4B6D2; text shadow `none`; tile shadow 3/84 em right and down in `shadowColor`; tile gap 0.08 em replaces the word gap, also between unspaced words | 5.2 makes `primaryColor` the body colour; the accent slot is the one user colour on tiles |
| Marker | Poppins lowercase S = 48, hero 120, alternates #FFD248/#EF8DB9, rowGap 0.14, guide 8%, `rise` | as catalog (Poppins is ExtraBold only, no new fonts); noHeroSizeEm 1.5; two-layer shadow | |
| Stack | Inter SemiBold lowercase S = 48, hero Inter 144, rowGap 0.04, `slide` | as catalog; hero tracking −0.03 em; noHeroSizeEm 1.5; two-layer shadow | the catalog is silent on tracking; −0.03 is Headline's adopted hero tracking |

**Legibility pass (shadows).** Method: render each case's settled frame on the bright background (and check dark and busy by eye), take every white support word's solid ink mask from its own text event, and measure the mean luminance of a ring 1 px to 0.075 em around it; contrast = 1.05 / (L + 0.05). Criterion: every support word at least 3:1 (WCAG AA for large text; every caption word is at least 40 px). Worst word per case:

| Shadow | headline-en | headline-short-words | headline-long-hero-fit | stack-en | editorial-en | marker-en | marker-urdu |
| --- | --- | --- | --- | --- | --- | --- | --- |
| none | 1.64 | 2.58 | 2.16 | 1.91 | 1.95 | 1.46 | 2.10 |
| old 65%, sigma 0.0375 em | 2.09 | 3.06 | 2.54 | 2.16 | 2.26 | 1.70 | 2.32 |
| 85%, sigma 0.06 em | 2.86 | 3.78 | 3.09 | 2.60 | 2.80 | 2.13 | 2.67 |
| **85%, sigma 0.075 em (Headline)** | **3.14** | **4.07** | **3.31** | 2.79 | 3.00 | 2.33 | 2.79 |
| 2 layers: 70% s0.10 + 60% s0.03 | 3.45 | 4.31 | 3.43 | 2.91 | 3.11 | 2.55 | 2.85 |
| **2 layers: 80% s0.12 + 80% s0.04 (small text)** | | | | **3.40** | **3.54** | **3.12** | **3.18** |

Headline takes the weakest single layer that passes. Shadows scale with each word's size, so 40 to 60 px support words get thin halos; no single layer up to 100% and sigma 0.15 em passed for them (best 3.13, 3.06, 3.02, 3.04, and those halos are heavy), so Editorial, Marker and Stack take the weakest two-layer shadow that passes: wide black 80%, sigma 0.12 em, 0.04 em down, under tight black 80%, sigma 0.04 em, 0.01 em down. On dark and busy frames the shadows only add contrast.

**Section 6, by style** (my judgement; Sol to confirm)

- Rule 6 conflicts that come from the catalog motions themselves, kept as specified: Editorial's `blur` blurs every word for up to 280 ms (rule: supporting words ≤ 90 ms, the hero the only blur); Cutout's `drop` takes 120 ms (≤ 90 ms for support words); Marker's `rise` travels 0.32 em over 200 ms and reaches full opacity at 140 ms (≤ 0.2 em, full opacity within 40 ms). The duration cap shortens all of them in fast speech.
- Rule 5: Editorial minor words are exactly 40 px at fit 1, so any fit below 1 puts them under the floor. No fixture triggers it; a long hero would.
- Rules 1, 3, 4 hold: hero ratios 2.4 (Editorial), 2.5 (Marker), 3.0 (Stack), 2.2 to 3.4 (Headline), Cutout exempt; row gaps 0.10, 0.14, 0.04 S; one hero colour per cue (Marker alternates between cues by seed: `marker-en` yellow, `marker-urdu` pink); Cutout is the "caps tiles in two colours" recipe.
- Against the references: Editorial is close to 06's foreground type but its sans minor words read smaller than 06's "with"; Cutout's row spans about 55% of the width at S = 84, where 05's spans about 85% (larger S would be a catalog change); Marker matches 04's layout (one hero; 04's second hero and underline are out of phase 1); Stack matches 08's hierarchy (stars are phase 2).

**Parity**

- Worker against geometry (real libass, `CAPTION_BLOCK_PARITY=1`, full table in `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/05/libass-parity.txt`), max |Δ| px over every word, moment (+33 ms for scaling or turning motions, +100 ms, settled):

  | Case | baseline | left | right | top | bottom | tile left / right / top / bottom |
  | --- | --- | --- | --- | --- | --- | --- |
  | editorial-en | 0.01 | 0.77 | 0.61 | 0.43 | 0.50 | |
  | cutout-en | 0.14 | 0.86 | 0.91 | 0.68 | 0.60 | 0.55 / 0.59 / 0.70 / 0.58 |
  | cutout-long-word-fit | 0.11 | 0.90 | 0.90 | 0.59 | 0.59 | 0.58 / 0.53 / 0.64 / 0.55 |
  | marker-en | 0.01 | 0.64 | 1.02 | 0.46 | 0.62 | |
  | marker-urdu | 0.00 | 0.48 | 0.63 | 0.66 | 0.59 | |
  | stack-en | 0.01 | 0.94 | 0.45 | 0.62 | 0.35 | |
  | stack-slam | 0.01 | 0.94 | 0.83 | 0.44 | 0.35 | |

- Studio layout against worker layout (Canvas vs HarfBuzz measurement through the same `layoutCaptionBlock`, settled, from the parity page's metrics): 0.00 px on baselines, advance-box edges, sizes and rotations for every Latin case (Editorial, Cutout, both fits, Marker, Stack, Headline). **Arabic script does not match:** `marker-urdu` baselines differ by up to 6.75 px and `headline-urdu` by up to 12.25 px (horizontal edges 0.00). Canvas and HarfBuzz report different Nastaliq ink, so row pitch differs. This predates ticket 05 (Headline has it since 03b/03c) and is over the 2 px tolerance; it belongs with 05b.
- Events per cue: Cutout 15 (5 words × tile shadow, tile, text); Editorial, Marker, Stack 12 (4 words × 2 shadow layers + text); Headline unchanged at 6 to 10. All under 120.

**Notes for ticket 04** (files it owns): Cutout has no hero (`style.emphasis === "never"`), so the Emphasis row and the Hero colour control have nothing to act on there. `applyBrandColorsToCaption` sends the brand primary to `highlightColor`, which Cutout does not draw; for a style with `emphasis: "never"` it should probably go to `primaryColor` (the tile ink). Motion pickers should offer `slam` and `drop` only for dynamic presets (`isDynamicOnlyMotion` already says so).

**Contact sheets** (worker vs Studio on dark, bright and busy; two entrance moments; a second case; the reference): `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/05/sheet-headline.jpg`, `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/05/sheet-editorial.jpg`, `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/05/sheet-cutout.jpg`, `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/05/sheet-marker.jpg`, `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/05/sheet-stack.jpg`. All frames: `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/05/worker/<case>/` (21 per case plus `frames.json`) and `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/05/studio/<case>/`. Docs page screenshot: `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/05/docs-caption-styles.png`. Worker and Studio frames agree by eye in every pair, including tiles mid-drop and the slam hero.

**Commands** (worktree root, Bun 1.4.4)

```sh
bun apps/media/scripts/caption-frames.ts "$OUT/worker" editorial-en cutout-en cutout-long-word-fit marker-en marker-urdu stack-en stack-slam headline-en headline-short-words headline-urdu
CAPTION_BLOCK_PARITY=1 bun test apps/media/src/caption-block-render.test.ts   # 21 pass, ~18 s
cd apps/web && bunx next dev -p 3225   # then /prototype/caption-parity?case=<id>&t=<frames.json sec>&bg=<dark|bright|busy>, shot with agent-browser at 1080x1920
bun run --cwd apps/api openapi:generate && bun test apps/api/src/domains/rest/app.test.ts -u
```

**Verification**

- `bun run lint`: exit 0 (20 warnings, 1 info; the 03a baseline, none in changed files).
- `bun run typecheck`: 15 of 15 tasks.
- `bun run test`: every package passes after the fast ASS test was taught tiles: validators 905, composition-plan 140, caption-fonts 122, services 1629, api 984, api-client 232, web 1159, mcp-core 170, media 1030; 0 failures.
- `bun run check:web-split`: passed. `bun run --cwd apps/api openapi:check`: matches all 32 REST operations. `bun run --cwd apps/api test:inventory`: 301 routes, 0 problems.
