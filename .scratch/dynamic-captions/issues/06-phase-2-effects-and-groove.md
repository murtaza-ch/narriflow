# 06 - Phase 2 effects and groove

**What to build:** Groove, the Headline gradient, the Marker underline and the Stack stars ship (spec 5.10, catalog).

**Blocked by:** 05

**Status:** claimed (built and verified; waits only on Sol's visual review)

Spec: [../spec.md](../spec.md). Follow the spec; where a ticket and the spec disagree, the spec wins.

## Acceptance

- [x] DM Serif Display and Caprasimo vendored per the font procedure; Groove style.
- [x] Gradient bands (worker) and `background-clip: text` (Studio), restricted to motions without scale or rotation.
- [x] Shared decoration point lists with identical-points test; underline wipe and stars with the drop rule.
- [ ] Sol visual review recorded.
- [x] `bun run lint`, `bun run typecheck`, `bun run test` pass (Bun 1.4.4). No PostgreSQL or heavy suites.

## Comments

### Opus, 2026-11-19: phase 2 effects and Groove built

Not committed. Sol's visual review is the only open box.

**Fonts.** DM Serif Display Regular and Caprasimo Regular, both SIL OFL 1.1, from `github.com/google/fonts` at commit `cc5661d43cd4f9aad5567033a8e15ca28dc35c86` (`ofl/dmserifdisplay/DMSerifDisplay-Regular.ttf`, `ofl/caprasimo/Caprasimo-Regular.ttf`); licences copied from each folder's `OFL.txt` to `packages/caption-fonts/licenses/{dmserifdisplay,caprasimo}-OFL.txt`. SHA-256 `8cc36435…ab616` and `786ab84e…ced90`, pinned in `apps/media/runtime-lock.json`. Metrics from the files (OS/2 win metrics ÷ unitsPerEm, "H" top): DM Serif Display 1.036 / 0.335 / cap 0.66 (UPM 1000), Caprasimo 0.918 / 0.229 / cap 0.6758 (UPM 2048; its OS/2 sCapHeight 0.70 is not the "H" top the catalog uses). Full names "DM Serif Display Regular" and "Caprasimo Regular". Registered in `CAPTION_FONT_FACES` and `apps/web/app/caption-fonts.ts` (next/font/local with the overrides). The glyph coverage script ran and its table is unchanged: it covers the fallback faces only.

**What changed**

- `packages/validators`: new `caption-decoration.ts`: `CAPTION_DECORATION` (timings and sizes), `CAPTION_SHAPES` (squiggle ribbon and five-point star as unit-box point lists, `M`/`L`/`C` only, control points inside the box), `captionShapeSvgPath` and `captionShapeAssDrawing` from one `captionShapePoints`. `caption-dynamic.ts`: the `groove` style, Headline `gradient`, Marker `decorations: ["underline"]`, Stack `decorations: ["stars"]` plus `accentColor` `#FFFFFF`, `captionHeroGradient` (the shared fallback rule), `captionDecorationColour`, and `captionStyleUsesAccent` counts decorations. `caption-preset.ts`: the `groove` preset, sixth in the Dynamic group (30 presets).
- `packages/caption-fonts/src/caption-block.ts`: `layoutCaptionBlock` returns `decorations` (shape, box, colour, onset, star pop keyframes, underline wipe with a whole-pixel clip) and `gradient` (the hero words' rest ink box and colours). It applies the drop rule and upright-hero rule, reserves the underline in row pitch, and includes decorations in the fit envelope and safe area (stars at their 1.1 overshoot).
- Worker (`caption-ass.ts`): a gradient hero's text layer becomes `\clip` bands (`captionGradientBands`, `CAPTION_GRADIENT_BANDS`). Its shadow, outer stroke and glow events stay whole. Decorations are `\an5` `\p1` drawings on new layers 14 (shadows) and 15 (fills): stars pop through `\fscx`/`\fscy` `\t`, the underline wipes through `\clip(…)\t(60,180,\clip(…))`. They start at the hero's onset and end at the cue's end.
- Studio (`caption-block-painter.tsx`, `caption-block-pose.ts`): the gradient hero's text element takes `background-clip: text` with stops at the shared ink box. Its box is padded 0.25 em so overhanging ink keeps the fill, and the soft shadow stays its own element behind it. Decorations are SVG paths of the same shapes inside wrapper elements (`DecorationLayer`). The playhead drives them through `captionDecorationPose` and `captionWipeClipPath`; reduced motion shows them settled.
- Plan fixtures: `groove-en` (the scorer picks "Ready" on its own, rows GET / Ready / W/ ME). The fixture test now compares subtitle text with the preset's case applied (Groove uppercases `words[].text`; roles never touch it).
- Everywhere a preset appears: REST snapshot and public OpenAPI regenerated (`groove` added twice each); backdrop `groove: "warm-podcast"`. Sample cue and MCP upload card iterate the catalog, so Groove is covered without edits. The parity page's metrics carry `decorations` and `gradient`. `caption-frames.ts` counts decorations in "settled". The docs page gains a Groove section and text for the gradient, the squiggle, stars and the 0.3 s rule, with Headline, Marker, Stack and Groove frames re-rendered from worker frames.

**Values and interpretations**

| Item | Built | Why |
| --- | --- | --- |
| Groove | DM Serif Display caps S = 64, Caprasimo hero `capitalize` 176 px (2.75 S) `#F59ABB`, white support, rowGap 8 px, no outline, `slide`, noHeroSizeEm 1.5 | catalog; no-hero size as the other stacks |
| Groove shadow | two layers: black 90%, sigma 0.12 em, 0.04 em down + black 90%, sigma 0.04 em, 0.01 em down | Ticket 05's ring method on the bright frame, worst word "W/": none 1.85, catalog "4 px" (85%, sigma 2 px) 2.07, Headline's layer 2.44, small-text pair at 80% 2.86, **this 3.01**, 100% 3.17. Weakest that passes 3:1. Dark and busy are 9:1 or better with any shadow. |
| Gradient | `#A5EBC5` → `#36B780` over the hero words' rest ink box, held flat beyond | spec 5.10 |
| Gradient fallback | flat hero when the motion scales or turns the hero (scale, rotateX/Z keyframes or a tilting motion: slam, punch, bounce, drop, flip) **or when `highlightColor` is not `#36B780`** | The colour condition is my addition. With a constant gradient the Hero colour control and brand colours would do nothing on Headline (a dead end). Now picking another colour gives that colour flat, and picking the green again brings the gradient back. |
| Bands | 8 px, edges on even rows, cover rest ink + entrance travel + 2 sigmas of blur, full frame width; at most 48 per word, growing to the smallest even height that fits 48 only past the catalog sizes | spec allows both limits only up to a 384 px span; growing keeps both the cap and the event budget |
| Underline | centre line 0.12 hero-em under the baseline, **or lower so its box clears the hero's ink by 0.03 em**; 0.04 thick in a 0.10 em box, 3 waves, width 0.6 of the hero row's advance from the row's start (right end for RTL), white; wipe 60–180 ms from the reading side; with the style's soft shadow, clipped too | 0.6 and left start follow reference 04. The descender rule is a deviation: at 0.12 em the squiggle crosses "p", "g" and Nastaliq tails. RTL wipes right to left (spec says "left to right"; I read that as reading direction). |
| Underline conditions | needs a hero row, an upright hero (no block tilt, tile tilt or turning entrance) and 300 ms of cue left at the hero's onset | spec |
| Stars | three: 0.28, 0.20, 0.20 hero-em at the leading top corner, the other top corner and the bottom corner under the second, centres 0.3 hero-em out on both axes from the block's rest ink box, odd seeds mirror; pop 0 → 1.1 (80 ms, out) → 1 (120 ms), from 60 ms, 40 ms apart; accent colour (Stack default white); style's soft shadow | The spec gives two sizes and "corners", not a count. Three matches reference 08's layout. Accent rather than literal white gives Stack's new Accent colour control something to act on. |
| Decoration shadow scale | the support size S × fit | hero-em halos looked mushy on 30 px stars |

**Section 6.** Rule 1: Groove 2.75, Headline 2.2 to 3.4, Marker 2.5, Stack 2.4. Rule 2: Groove is "display hero with serif caps support". Rule 3: Groove's ink gaps are 8 px, and the underline is reserved, so Marker's tail row keeps its 0.14 S gap under the squiggle. Rule 4: one hero colour; the Headline gradient is the hero's colour, and decorations are white. Rule 5: shadows above. Rule 6: decorations finish by 260 ms. Rule 7: decorations sit in reserved space and touch no other row. Rule 8: they are in the safe area (test). Against the references: Groove's support caps read smaller than reference 03's (catalog 64 / 176 = 36% of the hero against about 60%). Stack's stars are smaller and further out than reference 08's (catalog 0.20 / 0.28 hero-em and 0.3 push). Both are kept as specified, for Sol to judge.

**Parity**

- Real libass (`CAPTION_BLOCK_PARITY=1`, 23 pass; full table in `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/06/libass-parity.txt`). Words in every case, max |Δ| px: baseline 0.23, left 1.39, right 1.56, top 0.76, bottom 0.60; groove-en 0.01 / 0.64 / 0.99 / 0.43 / 0.47. Gradient: in every hero and moment, the union of the bands, each kept to its own clip, equals the whole word's solid mask pixel for pixel (36 to 41 bands per word, 22 to 24 for the fitted and 2-word heroes). Decorations, solid masks against the shared box (stars scaled by the shared pop at mid-pop and settled; the underline also mid-wipe with its clip kept): max |Δ| 1.36 left / 1.35 right / 1.16 top / 0.93 bottom. Tiles 0.71.
- Studio against worker (parity page metrics against `captionBlockGeometry`, settled; `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/06/studio-vs-worker.md`): 0.00 px on baselines, left edges and sizes; gradient box top and bottom 0.00; decoration boxes and wipe clips 0.00. Covers headline-en, headline-number-unit, headline-urdu, marker-en, marker-urdu, stack-en, stack-slam and groove-en.
- Events per cue: headline-urdu 83 (max: Nastaliq 2-word hero, 41 + 36 bands), headline-number-unit 53, headline-japanese and headline-override-hero 45, headline-short-words and headline-urdu-punctuation 43, headline-en 41, headline-long-hero-fit 31, stack 21 (12 + 3 stars × 3), marker 15 (12 + underline × 3), cutout 15, editorial and groove 12, no-hero Headline cues 6 to 8. All under 120.

**Contact sheets** (worker | Studio per row, three backgrounds, onset +33 ms, hero +33 ms, hero +120 ms (underline mid-wipe, stars popping), a second case, the reference): `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/06/sheet-headline.jpg`, `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/06/sheet-marker.jpg`, `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/06/sheet-stack.jpg`, `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/06/sheet-groove.jpg`. Frames: `…/scratchpad/06/worker/<case>/` and `…/scratchpad/06/studio/<case>/` (same root). Docs page screenshot: `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/06/docs-caption-styles.png`. Temporary scripts (shots, sheet, parity, legibility, docs): `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/06/scripts/`. In every pair the worker and Studio frames agree by eye, including the gradient, the half-wiped squiggle and the half-popped stars.

**Commands** (worktree root, Bun 1.4.4)

```sh
bun apps/media/scripts/caption-frames.ts "$OUT/worker" headline-en marker-en marker-urdu stack-en groove-en
CAPTION_BLOCK_PARITY=1 bun test apps/media/src/caption-block-render.test.ts   # 23 pass, ~36 s
cd apps/web && bunx next dev -p 3227   # /prototype/caption-parity?case=<id>&t=<sec>&bg=<dark|bright|busy>
bun run --cwd apps/api openapi:generate && bun test apps/api/src/domains/rest/app.test.ts -u
```

**Verification** (Bun 1.4.4, worktree root): `bun run lint` exit 0 (the baseline 20 warnings and 1 info); `bun run typecheck` 15/15; `bun run test` 14/14 (validators 920, composition-plan 142, caption-fonts 137, services 1629, api 984, api-client 232, web 1166, media 1040, mcp-core 170, the rest pass; 0 failures); `bun run check:web-split` passed; `bun run --cwd apps/api openapi:check` matches 32 operations; `bun run --cwd apps/api test:inventory` 301 routes, 0 problems. No PostgreSQL or heavy suites, no `next build`.
