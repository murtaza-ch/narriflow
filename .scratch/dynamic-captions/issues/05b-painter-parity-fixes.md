# 05b - Painter parity fixes

**What to build:** The Studio painter and the libass painter agree on easing, word direction, scale pivot and shadow blur, and the Studio probe stops forcing layout during render. Findings from the Opus review of 03b + 03c (2026-11-19).

**Blocked by:** 05 (it edits both painters).

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

## Acceptance

- [ ] Findings 1 to 5 fixed with tests; 6 tests added.
- [ ] `bun run lint`, `bun run typecheck`, `bun run test` pass (Bun 1.4.4). No PostgreSQL or heavy suites.

## Comments
