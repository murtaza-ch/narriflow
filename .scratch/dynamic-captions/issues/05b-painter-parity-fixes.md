# 05b - Painter parity fixes

**What to build:** The Studio painter and the libass painter agree on easing, word direction, scale pivot and shadow blur, and the Studio probe stops forcing layout during render. Findings from the Opus review of 03b + 03c (2026-11-19).

**Blocked by:** 05 (done).

**Status:** done

Spec: [../spec.md](../spec.md).

## Findings to fix

1. Medium-high. The Studio samples opacity and travel with eased keyframes (`caption-block-pose.ts` via `captionKeyframeValue`), the worker draws `\fade` and one `\move` linearly from first to last keyframe (`caption-ass.ts`). Fix in shared code: opacity linear between its first and last keyframe; offsets linear over the shared `\move` window (earliest first to latest last keyframe). The classic engine already does this (`caption-style-engine.tsx`). Pose test for `blur` and `bounce`. The libass test samples offsets the same eased way and must change too.
2. Medium. Neutral words in RTL cues (`50،`, `(50)`) take a different character order: the worker measures with `textDirection(text, "ltr")` and libass picks direction from the text; the Studio uses the cue direction and `dir="rtl"`. Fix: one shared word direction; the worker measures with it and prefixes U+200F to RTL word events. Fixture word with trailing punctuation.
3. Low, must land before Sol's visual review of 05. Scale pivot: libass scales an `\an5` event about the line-box centre; the Studio about the ink centre. Fix the Studio transform to `rotate translate translate(o) scale translate(−o)` with `o` = line-box centre − rest centre (or move the shared pivot so both agree). Test with a `punch`/`slam` hero.
4. Low. Shadow blur combine: worker adds radii, CSS nests filters (root of sum of squares). Worker uses `Math.hypot`.
5. Low, perf. `baselineOffsetPx` probes during render with an exact-float cache key; round to 0.25 px, probe in the layout effect, re-measure when a late font loads.
6. Low, tests. Add a +45 ms moment for body-word slides in the real-libass test; re-run the kerning (AVAVAV) and budget checks on the worker image when possible.

Art note from the same review: Urdu support words fall back to Nastaliq and read small and thin at S = 80. Consider a per-script size floor for support words (judge on frames).

Found by the ticket 04 agent: the Captions panel live preview (03c) clips the top of tall blocks in its 112 px box (`scratchpad/04/emphasis-hero.png`). Fit the block into the preview box (scale the stage to the block's reserved bounds) instead of cropping.

## Added after ticket 05 (orchestrator, 2026-11-19)

7. Arabic-script parity: Studio vs worker baselines differ by up to 12.25 px on `headline-urdu` and 6.75 px on `marker-urdu`, because Canvas and HarfBuzz measure Nastaliq ink differently, so row pitch differs. Fix so both renderers feed the shared geometry the same ink for such words. Preferred: for words drawn by a fallback face whose ink the browser measures differently, both sides use the face's pinned line ink (the same numbers `caption-script-fonts` / the glyph planner already pin for line boxes) instead of per-glyph measured ink. Investigate and pick the simplest deterministic option; record the measured result. Tolerances: baselines 2 px.
8. Art direction (orchestrator calls, judged on the 05 contact sheets):
   - Stack: support words read too small next to the hero (reference 08 has support at about 45% of the hero's cap height). Raise Stack S to 64 and set the hero to about 2.4 S, keeping section 6 rule 1 (hero at least 2.2 times body after fit).
   - Cutout: reference 05 tiles are taller and rounder. Try pad 0.16 × 0.12 em and radius 0.1 em; keep whichever reads closer to the reference on the bright frame.
   - Editorial and Marker default motions break section 6 rule 6 (Editorial `blur` blurs every word for 280 ms; Marker `rise` travels 0.32 em). Set both styles' default motion to `slide` (hero-only blur, short travel). `blur` and `rise` stay selectable.
   - Editorial minor words sit exactly at the 40 px floor, so any fit shrink breaks rule 5. Raise Editorial minor to 44 px.
   - Urdu support words read small and thin (see the art note above): apply a per-script floor if the frames confirm it.
9. No-hero styles (Cutout): the Captions panel hides the Emphasis row and the Hero colour control (they act on nothing), and `applyBrandColorsToCaption` sends the brand primary to the text colour instead of the hero colour for styles with `emphasis: "never"`. Tests for both.

Re-render the contact sheets for every style after these changes (worker vs Studio, three backgrounds) into `scratchpad/05b/`.

## Acceptance

- [x] Findings 1 to 5 and 7 to 9 fixed with tests; 6 tests added; contact sheets re-rendered.
- [x] `bun run lint`, `bun run typecheck`, `bun run test` pass (Bun 1.4.4). No PostgreSQL or heavy suites.

## Comments

### Opus, 2026-11-19: parity fixes and art calls landed

Not committed.

**Findings**

1. **Easing (shared pose).** `packages/validators/src/caption-style.ts` adds `captionEntrancePose(keyframes, atMs)`, `captionTravelWindow` and `CAPTION_REST_POSE`. They encode what libass can draw: opacity linear from its first to its last keyframe (one `\fade`), offsets linear over one `\move` window (earliest first to latest last offset keyframe), scale, blur and turns segment by segment with each ease (`\t`). The Studio's `captionBlockWordPose` is now the time scale plus that function. The worker's `motionTags` takes its `\move` window from `captionTravelWindow`. The real-libass test samples the same function. Before this, `blur` and `bounce` faded in eased in the Studio and linearly in the export. Tests: validators (blur, bounce, a two-track move window), web pose test (blur, bounce, duration cap).
2. **Word direction.** `caption-block.ts` exports `captionBlockDirection(texts, language)`, `captionWordDirection(text, cueDirection)` and `CAPTION_RTL_MARK`, and both painters use them. The worker measures each word in its shared direction and starts an RTL word's events with U+200F. The mark has to be planned and measured with the word, not pasted in. Measured on libass: with Inter, which lacks U+200F, libass drew the mark in a fallback face and moved `(50)` 10 px down. So the mark is its own planned part (`CaptionGlyphPlanner.markFace`). It uses one of the word's own faces that has the glyph, else the chain face that grows the word's line box least (Noto Sans Hebrew fits inside Inter). `Span.clusters` carries the planned clusters into the event text. Fixture `headline-urdu-punctuation` (`قیمت 50، اب کم`, hero `50،`). Both painters draw the comma to the left of 50. Real libass is within tolerance (baseline 0.22, edges 0.72 px).
   Two shared-rule gaps the new fixture exposed, fixed at the source:
   - Fallback order for neutral text (`orderCaptionFallbackFaces`). After Inter digits, the worker drew `،` in Noto Sans Arabic while the browser stack drew it in Nastaliq (8.02 px of advance). Neutral text (punctuation, digits, marks only) is now led by the language's face, as the Studio's stack does. No classic snapshot changed.
   - Letter spacing on script punctuation (`captionShapingSensitivity`). Chrome sets `،` without tracking, and so does libass in the script face. The Studio's spacing runs counted it as neutral and removed one trailing spacing that was never drawn (4.08 px). Punctuation whose Script_Extensions name a joining or complex script and neither Latin nor Han (`،`, `؛`, `؟`, `।`, `॥`) is now "sensitive". CJK `、` `。` `《` stay neutral; they list Mongolian or Tibetan in their Script_Extensions, hence the Latin/Han exclusion.
3. **Scale pivot.** Landed in 05 (each element scales about its own origin). Added a web test that evaluates a slam hero's CSS transform on points against libass's order (scale about `\pos`, move, turn about `\org`). The real-libass `stack-slam` +33 ms rows cover the worker.
4. **Shadow blur.** `motionTags` combines a layer's blur and the entrance blur with `Math.hypot`. The classic path shares `motionTags` and the classic CSS nests the same filters, so the rule applies to both. One classic snapshot changed on purpose: Cinema (soft shadow plus `blur`), 9 lines, the shadow layer's starting `\blur` 23.1 → 17.04. Its rest value is unchanged.
5. **Probe.** `baselineOffsetPx` is a pure cache read in render. Before the first probe, the ascent stands in. `probeBaselineOffsets` runs in a layout effect and probes every missing face and size in one layout. The cache is keyed per face and quarter pixel; the first size seen in a bucket is probed exactly, and other sizes in that bucket follow the ascent from it. A plain quarter-pixel probe put one fit-scaled hero 0.96 px off, because Chrome rounds the ascent per size; probing the first exact size brings it back to 0.013 px. On `document.fonts` `loadingdone` the cache is cleared and the words are probed again. Measured DOM baseline against layout: |Δ| ≤ 0.013 px, left edges ≤ 0.015 px (headline-en, long-hero-fit, stack-en, marker-urdu, editorial-en, cutout-long-word-fit).
6. **Tests.** The real-libass test has a +45 ms moment for words with a sideways slide (`slide` body words), next to +33 ms (scale or turn), +100 ms and settled; 22 pass. **Not done:** the kerning (AVAVAV) and budget re-runs on the worker image; Docker images are excluded from verification here. Both still pass locally.
7. **Nastaliq baseline drift.** Root cause: Canvas fake-bolds. Every script face is one regular file. At the role's weight (600 or more), Canvas synthesizes bold, which puts ink 1/64 em further out at top and bottom and leaves the advance unchanged. The DOM draws with `font-synthesis: none` and libass never synthesizes. Measured in Chrome: `فیصد` in Nastaliq at weight 400 gives ink 1.121/0.102 em, exactly HarfBuzz; at 600 to 800 it gives 1.1366/0.1176. Noto Sans JP behaves the same way: `headline-japanese` was off by up to 12.9 px. Fix, the simplest deterministic one: the Studio measures with `normal 400 100px <stack>`. Every caption family holds one face (one `localFont` per catalog face, one family per brand font), so the weight selects nothing and Canvas has nothing to synthesize. The pinned-line-ink option was not needed. The classic `measureCaptionFallbackInkEm` (pill and plate extents) had the same bug and gets the same fix.
8. **Art.** Judged on rendered dark, bright and busy frames. Final values and reasons are below.
9. **No-hero styles.** `captionStyleDrawsHero(style)` (validators). For Cutout the panel hides Hero colour, the Emphasis row, Hero font and Emphasis size. The last two act on nothing either, and the owner's no-dead-ends rule applies. `captionPanelColors(style)` decides the colour fields and has a test (Headline text+hero, Marker text+hero+accent, Cutout text+accent). `applyBrandColorsToCaption` sends the brand primary to `primaryColor` for a style without a hero, and `brandColorsFromCaption` inverts it. There is a test, and the catalog round trip still matches every preset.

Panel preview (the 04 crop): `CaptionBlockFit` already scales the stage to the block's reserved bounds (03c). In a temporary harness (deleted), all 17 cases at settled and hero +33 ms fit the 320 × 112 stage with no crop. The likely cause of the 04 screenshot is the old probe: it ran in render, was cached forever, and could cache an offset measured before the face had loaded. Finding 5's re-probe on late loads covers that.

**Art values**

| Item | Before | After | Why |
| --- | --- | --- | --- |
| Stack | S 48, hero 3.0 S (144 px) | S 64, hero 2.4 S (153.6 px) | Support cap height is about 42% of the hero's, as in reference 08; rule 1 holds (2.4 ≥ 2.2). |
| Cutout tiles | pad 0.12 × 0.08 em, radius 0.05 em | pad 0.16 × 0.12 em, radius 0.1 em | On the bright frame next to reference 05 (`cutout-try/compare-bright.jpg`), the taller, rounder tiles with more air around the caps read closer. |
| Editorial motion | `blur` | `slide` (preset `animation` and `defaultMotion`) | Rule 6: the hero is the only blur, and short travel. `blur` stays selectable. |
| Marker motion | `rise` (0.32 em) | `slide` | Rule 6: travel 0.18 em or less. `rise` stays selectable. |
| Editorial minor | 40 px | 44 px | Rule 5 still holds after a fit shrink. |
| Urdu support | role size | × 1.3 (`CAPTION_BLOCK.nastaliqSupportScale`) for minor and body words in Arabic script in an Urdu cue | On the frames (`urdu-try/urdu-before.jpg`, `urdu-1.3.jpg`), Nastaliq support words read about two thirds the size of Latin ones, and thin. Nastaliq heroes were fine, so heroes keep their size. Shared geometry decides it (`layoutCaptionBlock` gains `language`), so both painters agree. Rule 1 in px for Marker is now 120 / 62.4 = 1.92. Nastaliq draws about 0.7 of a Latin face's size, so the visual ratio is still above 2.2; read rule 1 visually for Nastaliq. |

Spec section 6 catalog rows and the docs page (`caption-styles.mdx`: motions, Cutout's hidden hero controls) are updated. The Editorial, Cutout and Stack docs frames were re-rendered from worker frames.

**Parity, Studio against worker** (layout from the parity page against `captionBlockGeometry`, settled, max |Δ| px over every word). After: 0.00 on baselines, left and right advance edges, sizes and centres in all 17 cases (`/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/6289a746-8e41-4f39-969b-a33de6c5bfdf/scratchpad/05b/studio-vs-worker.md`). Before, for the non-Latin cases:

| Case | Δ baseline before | after | Δ edges before | after |
| --- | --- | --- | --- | --- |
| headline-urdu | 12.25 | 0.00 | 0.00 | 0.00 |
| marker-urdu | 6.75 | 0.00 | 0.00 | 0.00 |
| headline-japanese | 12.92 | 0.00 | 0.00 | 0.00 |
| headline-urdu-punctuation (new) | 0.00 once 7 was fixed | 0.00 | 8.02, then 4.08 | 0.00 |

Worker against geometry (real libass, `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/6289a746-8e41-4f39-969b-a33de6c5bfdf/scratchpad/05b/libass-parity.txt`), max |Δ| baseline / left / right / top / bottom: headline-urdu 0.22 / 0.87 / 0.51 / 0.60 / 0.60; headline-urdu-punctuation 0.22 / 0.72 / 0.57 / 0.58 / 0.58; marker-urdu 0.01 / 0.59 / 0.66 / 0.49 / 0.40; headline-japanese 0.22 / 0.40 / 0.36 / 0.28 / 0.40. Worst over all 17 cases: baseline 0.22, edges 1.56 (headline-override-hero), tiles 0.71.

**Residual (not fixed, for review):** the scale origin of words drawn by a fallback face. libass scales an `\an5` event about the middle of the largest line box among the word's faces; the Studio uses the requested face's. The difference is 13.7 to 35.8 px for Nastaliq words on `headline-urdu` and 3.5 to 7.1 px for Noto Sans JP. It matters only during a scaling entrance (slam, punch, bounce; none is a default motion), for up to 160 ms. A fix would pin the script faces' win metrics and coverage in the browser; that is a separate ticket if wanted. Fixed in ticket 10 (vertical pivot; a horizontal pivot offset of up to 44 px remains open there).

**Contact sheets** (worker | Studio, three backgrounds, onset +33 ms, hero +33 ms, a second case, the reference): `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/6289a746-8e41-4f39-969b-a33de6c5bfdf/scratchpad/05b/sheet-headline.jpg`, `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/6289a746-8e41-4f39-969b-a33de6c5bfdf/scratchpad/05b/sheet-editorial.jpg`, `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/6289a746-8e41-4f39-969b-a33de6c5bfdf/scratchpad/05b/sheet-cutout.jpg`, `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/6289a746-8e41-4f39-969b-a33de6c5bfdf/scratchpad/05b/sheet-marker.jpg`, `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/6289a746-8e41-4f39-969b-a33de6c5bfdf/scratchpad/05b/sheet-stack.jpg`. Frames: `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/6289a746-8e41-4f39-969b-a33de6c5bfdf/scratchpad/05b/worker/<case>/`, `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/6289a746-8e41-4f39-969b-a33de6c5bfdf/scratchpad/05b/studio/<case>/`. Hero +33 ms is the first 30 fps frame after the hero's onset, plus one; the worker side is rendered from the same `.ass` with the frame script's ffmpeg filter. Temporary scripts: `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/6289a746-8e41-4f39-969b-a33de6c5bfdf/scratchpad/05b/scripts/`.

**Verification** (Bun 1.4.4, worktree root): `bun run lint` exit 0 (the 20 warnings and 1 info baseline); `bun run typecheck` 15/15; `bun run test` 14/14 (validators 910, composition-plan 141, caption-fonts 124, services 1629, api 984, api-client 232, web 1162, media 1033, mcp-core 170, the rest pass; 0 failures); `CAPTION_BLOCK_PARITY=1 bun test apps/media/src/caption-block-render.test.ts` 22 pass; `bun run check:web-split` passed; `bun run --cwd apps/api openapi:check` matches 32 operations (the public document and REST snapshot carry preset ids only, so the catalog changes do not touch them); `test:inventory` 301 routes, 0 problems.


Follow-up left open (orchestrator): fallback-face words (Nastaliq, Noto Sans JP) scale about the fallback face's line box in libass but the requested face's in the Studio, 3.5 to 35.8 px apart during slam/punch/bounce entrances only (none is a default motion). Tracked in ticket 10.
