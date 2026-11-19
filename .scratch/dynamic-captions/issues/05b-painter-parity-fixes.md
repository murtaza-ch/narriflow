# 05b - Painter parity fixes

**What to build:** The Studio painter and the libass painter agree on easing, word direction, scale pivot and shadow blur, and the Studio probe stops forcing layout during render. Findings from the Opus review of 03b + 03c (2026-11-19).

**Blocked by:** 05 (done).

**Status:** ready-for-agent

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

- [ ] Findings 1 to 5 and 7 to 9 fixed with tests; 6 tests added; contact sheets re-rendered.
- [ ] `bun run lint`, `bun run typecheck`, `bun run test` pass (Bun 1.4.4). No PostgreSQL or heavy suites.

## Comments
