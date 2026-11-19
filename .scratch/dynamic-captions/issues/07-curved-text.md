# 07 - Curved text

**What to build:** Rows can curve on an arc, with the Arc style and a Curve control (spec 5.11).

**Blocked by:** 06

**Status:** done

Spec: [../spec.md](../spec.md). Follow the spec; where a ticket and the spec disagree, the spec wins.

## Acceptance

- [x] `curve` preset field, arc geometry and fish-eye in `caption-block.ts`, `captionClusterOffsets` in shaping, cluster events and elements, straight fallback for shaping-sensitive and no-space scripts.
- [x] Arc style, Curve slider, fixture cases, real-libass cluster placement test.
- [ ] Sol visual review recorded.
- [x] `bun run lint`, `bun run typecheck`, `bun run test` pass (Bun 1.4.4). No PostgreSQL or heavy suites.

## Comments

### Opus, 2026-11-19: curved text and Arc landed

Not committed. Sol's visual review is the only open box.

**What changed**

- `packages/validators`: `caption-dynamic.ts` adds `CAPTION_CURVE` (maxSweepDeg 70, edgeShrink 0.18, maxEvents 200), `captionStyleCurves` (every style without tiles), `captionBlockPaintLayers` (shadow layers + outer + glow + fill, the budget's unit) and the `arc` style. `caption-preset.ts` adds the `arc` preset (seventh in the Dynamic group, 31 presets) with `curve: 0.55`.
- `packages/caption-fonts/src/caption-block.ts`: `captionTextClusters` (base code point + following `\p{M}`, no `Intl.Segmenter`), `captionBlockCurve` (the one straight-or-curved decision both painters ask), `captionClusterPositions`, `captionUnturnedTravel`, `MeasuredWord.clusters`, `PlacedWord.clusters` (`PlacedCluster`: px with fish-eye, baseline, centre, turn), `PlacedWord.keyframes` (the entrance both painters now draw; scale and turn stripped on curved rows), `CaptionBlockLayout.curve`. `arrange` now lays rows out in x first, bends curved rows on the arc, stacks curved rows by `columnPitch` (exact over the turned cluster boxes' corners), and reserves every turned cluster box plus the word's travel. Curved cues drop the block tilt, gradient and underline in shared code.
- `packages/caption-fonts/src/shaping.ts`: `captionClusterOffsets(clusters' parts, letterSpacing)`: each prefix laid out with spacing (adjacent same-face parts merged so it kerns as the word), each cluster alone without, plus each cluster's libass box centre.
- Worker: `caption-block-geometry.ts` cuts the word's plan into clusters (`plannedClusters`) and measures them; `caption-ass.ts` writes one event per cluster per paint layer at the cluster's `\pos`, `\org` at its centre, `\frz` its angle, `\fsp0`, motion px of the word, and `\move` travel turned back by the cluster's angle (`MotionPose.screenTravel`).
- Studio: `caption-block-painter.tsx` measures clusters with Canvas (prefix with `letterSpacing`, alone without; regular-weight font string from 05b), paints `CaptionBlockPaintItem`s (the word, or each cluster) per layer, each element with its own turn and screen travel; `caption-block-pose.ts` `captionBlockTransform(…, screenTravel)`.
- Captions panel: Curve slider under Advanced for styles without tiles (−1 to 1, centre origin, "Off" at 0, stored as unset). Arc's preset carries 0.55.
- Fixtures (8 new): `arc-en`, `arc-long-fit` (fit shrinks the curved lead row), `arc-urdu` (stays straight), `arc-bow` (−0.55), `headline-curve`/`headline-bow`, `stack-curve`/`stack-bow` (±0.5).
- Everywhere a preset appears: REST snapshot and public OpenAPI regenerated (`arc` twice each), backdrop `arc: "sunset-coast"`, docs page Arc section + Curve paragraph + `public/docs/caption-styles/arc.jpg` (worker settled frame). Sample cue and MCP card iterate the catalog (no edits). Spec 5.11 and the Arc catalog line updated.

**Interpretations and deviations**

1. **Arc direction.** 5.11's text says positive arches (middle higher); its formula `baselineY − sign × R(1 − cos φ)` bows a positive curve. The text and reference 14 win: `baselineY + R(1 − cos φ)` with R signed like the curve, rotation φ.
2. **Row pitch column by column**, not by the arcs' bounding boxes. Box pitch adds the whole drop of the row above (about 1 S on Arc) between arched rows, against rule 3; column pitch keeps the rows' ink rowGap apart where they share columns, so arches nest as in reference 14 and still never collide (unit test: separating-axis check on every cluster pair). Straight rows keep rule 4.
3. **Motion `slide`, not `blur`.** `blur` fades every word in over 280 ms behind a blur (rule 6: full opacity in 40 ms, hero the only blur), the same call 05b made for Editorial. `slide` keeps opacity, travel and a hero-only blur, all of which curved rows allow.
4. **Arc shadow.** Ring method (ticket 05) on the bright frame, cream text: black 70% single 2.43 ("how"), Headline's 85% 2.59, small-text pair 70% 2.93, **pair 80% 3.13** (chosen, `SMALL_TEXT_SOFT_SHADOW`), pair 90% 3.34. Arc is 3 events per cluster.
5. **Which text stays straight**, per cue: any word that `isShapingSensitiveText` (Arabic, Hebrew, Indic, Thai…), has a no-space script character, or is RTL, and any RTL cue. Per cue rather than per row, so a cue never mixes curved and straight rows.
6. **Budget enforced**, not just measured: clusters × `captionBlockPaintLayers` (+ stars) > 200 keeps straight rows (Arc: up to 66 clusters).
7. **Screen-space travel.** libass turns a moved event about its fixed `\org`, and CSS `rotate() translate()` turns the translation too; each cluster's travel is turned back by its own angle so the word's clusters move together on screen. Travel and blur use the word's px; the shadow layers use the cluster's (fish-eye) px, in both painters.
8. **Cluster positions** come from prefix and alone widths (both renderers), so kerning against the previous cluster moves a cluster as in the shaped word. A unit test caught that the first version shaped prefixes as one run per cluster (no kerning); fixed by merging parts.
9. **Curved hero is flat** (no gradient: bands × clusters pass the budget) and **Marker's underline is left out** on curved cues ("only on unrotated words"). Stars stay, at the arched block's corners.

**Parity**

- Real libass (`CAPTION_BLOCK_PARITY=1`, 31 pass, table in `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/07/libass-parity.txt`): 254 cluster checks (each cluster's text event as a solid mask taken back through its turn and travel, against HarfBuzz ink at the cluster's advance box), max |Δ| px: baseline 0.09, left 2.03, right 1.40, top 0.99, bottom 0.62 (tolerances 2 / 4 / 4). Straight words unchanged: 0.23 / 1.39 / 1.56 / 0.67 / 0.62.
- Studio vs worker layout (parity page metrics vs `captionBlockGeometry`, settled, `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/07/studio-vs-worker.md`): 0.00 px on word and cluster baselines, left edges, sizes, cluster turns and bounds in all 8 new cases (Canvas measures e.g. 0.49399994 em where HarfBuzz gives 0.494).
- Events per cue: arc-long-fit 129 (max curved), stack-curve/bow 60, arc-en/bow 42, headline-curve/bow 22, arc-urdu 12 (straight). All existing cases unchanged (max 83).

**Contact sheets:** `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/07/sheet-arc.jpg` (worker | Studio on dark, bright, busy at settled, hero +33 ms and onset +100 ms; arc-long-fit, arc-bow, arc-urdu straight; reference 14) and `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/07/sheet-curve-slider.jpg` (Headline and Stack: Curve off, +0.5 and −0.5, worker and Studio, plus entrances). Frames in `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/07/worker/<case>/` and `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/07/studio/<case>/`. Scripts (shots, parity, sheet, bounds) in `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/715217cb-0693-4158-8165-d91385cd1279/scratchpad/scripts/`. Note: the 49bb75c5 scratchpad was wiped during this ticket (the 06/06b sheets and scripts referenced above are gone).

**Verification** (Bun 1.4.4, worktree root): `bun run lint` exit 0 (baseline 20 warnings, 1 info); `bun run typecheck` 15/15; `bun run test` 14/14 (validators 929, composition-plan 152, caption-fonts 156, services 1629, api 984, api-client 232, web 1166, media 1059, mcp-core 170, the rest pass); `bun run check:web-split` passed; `openapi:check` 32 operations; `test:inventory` 301 routes, 0 problems; real-libass test 31 pass. No PostgreSQL or heavy suites, no `next build`.

