# 03b - Worker painter

**What to build:** Dynamic cues burn in through per-word ASS events placed by the shared geometry (spec 5.6 painting, 5.7).

**Blocked by:** 03a

**Status:** done

Spec: [../spec.md](../spec.md). Follow the spec; where a ticket and the spec disagree, the spec wins.

## Acceptance

- [x] Per-word measurement with `layoutCaptionLine` on single words; per-word, per-layer events from word start to cue end with `\pos`, `\org`, `\frz`, motion tags. Tiles as `\p1` shapes wait for ticket 05: no style has tiles until Cutout.
- [x] Classic snapshot from 00 unchanged except for the deliberate `Kerning: yes` header line (spec 5.6 painting overrides "byte-identical"; see the comment).
- [x] `apps/media/scripts/caption-frames.ts` renders fixture cases full-frame on the three backgrounds at the spec section 9 times.
- [x] A real-libass test (pattern of `caption-pill-render.test.ts`) finds each word's ink where the geometry says, within section 11 tolerances.
- [x] `bun run lint`, `bun run typecheck`, `bun run test` pass (Bun 1.4.4). No PostgreSQL or heavy suites.

## Comments

### Opus, 2026-11-19: worker painter landed

**What changed**

- `apps/media/src/caption-ass.ts`: a layer with a `block` paints through `blockCueEvents`. Each word is measured alone (`caption-block-geometry.ts`: `layoutCaptionLine` on that word, with the role's face slot, letter spacing and `CaptionGlyphPlanner` fallback faces). `layoutCaptionBlock` gets each word's `startSec` and the layer's `activeRange.endSec`. Each word then gets one event per paint layer through the existing `stackEvents`: shadow (the style's `softShadow` replaces `CAPTION_SOFT_SHADOW`), outer, glow and text. Events run from the word's onset to the cue's end with `\an5`, `\pos`/`\move`, `\org(centerX, centerY)` and `\frz(-rotationDeg)`, plus motion tags from `hero ?? word`, with `offsetXEm × motionSign` and keyframe times scaled by `PlacedWord.entranceTimeScale`. Scale 0 draws the word settled; unspoken words are not drawn. `\pos` uses the classic overlay's per-word correction (`bboxCenterEm − advance/2`, line-box centre to baseline). `motionTags` gained `offsetXEm` (one `\move` for x and y) and `rotateZDeg`/rest `\frz`. `Kerning: yes` is in every script. Classic lines take `captionClassicAnimation` (a dynamic-only motion draws as `fade`). Typed degradation: a `CaptionShapingError` while measuring a block draws the cue as the classic line and records `caption_geometry_unavailable` once per cue. `captionBlockGeometry` is exported for the tests and the frame script.
- New `apps/media/src/caption-block-geometry.ts` (worker measurement), `apps/media/scripts/dynamic-caption-fixtures.ts` (fixture cases through the real `planClipComposition`), `apps/media/src/caption-block-ass.test.ts` (fast ASS contract), `apps/media/src/caption-block-render.test.ts` (real libass).
- `apps/media/scripts/caption-frames.ts`: `bun apps/media/scripts/caption-frames.ts <outDir> <caseId>` renders a manifest case as `<caseId>.ass` plus `<caseId>/<background>-<moment>.jpg`: full 1080x1920 frames over dark, bright and busy, at the 7 moments, with `frames.json` holding the exact times for the Studio frames. Classic cases are unchanged.
- `packages/composition-plan/src/__fixtures__/dynamic-captions/backgrounds/{dark,bright,busy}.jpg`: the Studio's preset backdrops `dark-studio`, `bright-room` and `brick-street`, at 540x960 (scaled 2x when rendered).
- Shared packages, kept small: `packages/caption-fonts/src/shaping.ts` gives each `ShapedCluster` its horizontal ink (`inkLeftEm`/`inkRightEm`; used for the expected ink box in the libass test), and `index.ts` exports `ShapedCluster`. `packages/validators/src/caption-dynamic.ts` adds `isDynamicOnlyMotion` and `captionClassicAnimation` (with a test); the 03c Studio painter uses the same function.
- `apps/media/src/__snapshots__/caption-ass.test.ts.snap`: all 24 classic snapshots gain one line, `Kerning: yes`, and nothing else (diff: 24 added lines).
- `.scratch/dynamic-captions/references/budget-03b.ts`: the budget measurement below.

**Interpretations** (for review)

1. **No per-glyph `\fsp`; one `\fsp` per word stays.** The spec asked for per-glyph-cluster `\fsp` (tracking plus HarfBuzz kerning), based on the ticket 02 proof. The proof's style used Encoding 1. The worker's Caption style uses Encoding -1, and there libass keeps kerning under a uniform `\fsp` once `Kerning: yes` is set. Per-glyph `\fsp` is then wrong: neighbouring glyphs with equal values share a shaping run that libass kerns a second time. Measured with local ffmpeg 7.1.5 and libass 0.17.5, Inter ExtraBold at 150 px, `\fsp` −0.03 em, ink width in px:

   | Word | HarfBuzz kerned | Enc −1, one `\fsp` | Enc −1, per-glyph | Enc 1, one `\fsp` | Enc 1, per-glyph | Enc −1, `Kerning: no` |
   | --- | --- | --- | --- | --- | --- | --- |
   | AVAVAV | 562.4 | **564** | 501 | 644 | 564 | 644 |
   | Accurate | 624.1 | **626** | 626 | 632 | 626 | 632 |
   | Tyrant | 439.7 | **440** | 440 | 452 | 440 | 452 |

   So the intent ("letter spacing keeps kerning") is met without per-glyph tags. Splitting runs would also unjoin cursive text. Two real-libass tests guard it: the Headline hero (−0.03 em) in every fixture, and a classic "AVAVAV" line at −0.03 em, which must match HarfBuzz's kerned width within 4 px. Unkerned, it is about 80 px wider.
2. **Which classic snapshots changed and why.** All 24, by the single `Kerning: yes` header line. Their ASS is otherwise byte-identical. Rendered output changes wherever a kerning pair occurs: before this, libass drew every classic preset unkerned while HarfBuzz measured kerned pills, plates and overlays. 23 presets also set letter spacing, and they now kern under it too: bold-pop, blast, punch, spotlight, street, electric, rise, focus, glass, sticker, frosted-glass, highlighter, bubblegum, jelly, candy, retro, afterglow, karaoke, neon, glitch, flip, typewriter and block. Cinema has zero spacing and gains kerning only. No classic preset holds a dynamic-only motion, so `captionClassicAnimation` changes no snapshot.
3. **Frame moments.** Onset is the first 30 fps frame at or after the cue's first spoken word. +33, +100 and +200 ms are 1, 3 and 6 frames after it. Settled is the first frame at or after every word's duration-capped entrance, and cue end − 1 frame is the last frame before `activeRange.endSec`. At the onset frame itself, the first word is at opacity 0, because its fade starts there; the Studio pose is the same.
4. **The libass test measures two moments per word:** 100 ms after its onset (when that is before the cue's last frame) and settled (cue end − 1 frame). The expected pose comes from the shared keyframes sampled at `t / entranceTimeScale`. The pose model covers travel, opacity and blur. The test fails loudly on scale or rotation keyframes, or on a turned word (Headline has none); tickets 05 and 06 extend it.
5. **Parity method** (ticket 02 `parity.ts`). The libass baseline is computed from the word's text event alone: `\pos`/`\move` at libass's integer-ms clock, plus the line box from the OS/2 win metrics of every face that draws text in the event, matched by full name. The model is calibrated once on a flat-bottomed "H" (2 faces × 2 sizes × 4 sub-pixel y values; offset under 0.25 px, every residual within 0.1 px of it). It is compared with the geometry's `baselineY` plus the shared pose. Ink comes from solid white masks (no fade, no blur, coverage ≥ 50 %) against HarfBuzz glyph ink placed at the geometry's advance box plus the pose. Empty, tiny or frame-filling masks throw.
6. **Typed degradation** keeps the Studio's block (the accepted mismatch). The fast test uses a real Inter face wrapped as an uncompressed WOFF 1: fontkit (the glyph planner) reads it, and HarfBuzz refuses it.
7. **Tiles** are not built: no style has tiles before Cutout (ticket 05).
8. **Budget.** This was measured locally, not on the worker image (no Docker, per the orchestrator). Spec section 8 asks for the worker image, so that measurement is still owed. Headline here is phase 1, with a flat hero and no gradient.

**Budget**

Events per cue for the fixture cases (limit 120): headline-en 6, headline-number-unit 8, headline-gate-no-hero 8, headline-urdu 8, headline-japanese 6, headline-short-words 8, headline-long-hero-fit 10, headline-override-hero 6, headline-override-plain 6. Each word is 2 events (soft shadow and text). Headline has no outline or glow.

libass time for a 20 s 1080x1920 clip: the proof's 12 cues as one utterance, through the real plan. Headline gives 12 cues and 88 events (6 to 8 per cue); Bold Pop gives 16 cues and 176 events. Input is the proof backdrop looped at 30 fps. Machine: Apple M1 Pro with local Homebrew ffmpeg 7.1.5 and libass 0.17.5, load average 4 to 8. Medians of 5 interleaved runs:

| Mode | None | Bold Pop | Headline | Headline / Bold Pop |
| --- | --- | --- | --- | --- |
| filter only, wall s | 1.34 | 1.36 | 1.37 | **1.01x** |
| filter only, CPU s | 1.37 | 2.32 | 2.38 | 1.03x |
| encode (libx264 veryfast crf 21), wall s | 1.47 | 1.56 | 1.72 | **1.10x** |
| encode, CPU s | 6.21 | 8.04 | 7.87 | 0.98x |

This is within the 1.35x budget.

**Parity, worker against geometry** (Δ = libass − geometry, px; tolerances: baseline 2, left 4, bounds 4). Max |Δ|: baseline 0.22, left 1.39, right 1.56, top 0.70, bottom 0.58. Every word in every case is within tolerance at both moments.

| Case | Word | Moment | Geometry baseline | libass baseline | Δ baseline | Geometry ink x / y | libass ink x / y | Δ left | Δ right | Δ top | Δ bottom |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| headline-en | the | +100 ms | 1269.64 | 1269.65 | 0.01 | 481-597 / 1211-1271 | 481-597 / 1211-1271 | 0.04 | -0.25 | -0.44 | 0.42 |
| headline-en | the | settled | 1269.64 | 1269.65 | 0.01 | 481-597 / 1211-1271 | 481-597 / 1211-1271 | 0.04 | -0.25 | -0.44 | 0.42 |
| headline-en | BEST | +100 ms | 1487.21 | 1487.21 | 0.01 | 216-871 / 1286-1490 | 217-871 / 1286-1490 | 0.97 | -0.01 | -0.26 | -0.26 |
| headline-en | BEST | settled | 1476.33 | 1476.33 | 0.01 | 216-871 / 1275-1479 | 217-871 / 1275-1479 | 0.97 | -0.01 | -0.38 | -0.38 |
| headline-en | part | +100 ms | 1537.03 | 1537.04 | 0.01 | 469-614 / 1484-1553 | 469-614 / 1484-1553 | -0.18 | 0.33 | -0.18 | -0.36 |
| headline-en | part | settled | 1537.03 | 1537.04 | 0.01 | 469-614 / 1484-1553 | 469-614 / 1484-1553 | -0.18 | 0.33 | -0.18 | -0.36 |
| headline-number-unit | I | +100 ms | 1341.40 | 1341.40 | 0.01 | 422-433 / 1283-1341 | 422-433 / 1283-1341 | -0.28 | 0.33 | -0.19 | -0.40 |
| headline-number-unit | I | settled | 1341.40 | 1341.40 | 0.01 | 422-433 / 1283-1341 | 422-433 / 1283-1341 | -0.28 | 0.33 | -0.19 | -0.40 |
| headline-number-unit | made | +100 ms | 1341.40 | 1341.40 | 0.01 | 461-660 / 1283-1342 | 461-660 / 1283-1342 | 0.16 | -0.26 | -0.19 | -0.33 |
| headline-number-unit | made | settled | 1341.40 | 1341.40 | 0.01 | 461-660 / 1283-1342 | 461-660 / 1283-1342 | 0.16 | -0.26 | -0.19 | -0.33 |
| headline-number-unit | 20 | +100 ms | 1486.58 | 1486.59 | 0.01 | 114-329 / 1354-1489 | 115-328 / 1355-1489 | 0.62 | -0.56 | 0.70 | 0.40 |
| headline-number-unit | 20 | settled | 1479.42 | 1479.43 | 0.00 | 114-329 / 1347-1481 | 115-328 / 1347-1481 | 0.62 | -0.56 | -0.13 | -0.43 |
| headline-number-unit | dollars. | +100 ms | 1483.22 | 1483.30 | 0.08 | 380-964 / 1353-1485 | 380-965 / 1353-1485 | -0.16 | 1.31 | 0.05 | -0.41 |
| headline-number-unit | dollars. | settled | 1479.42 | 1479.43 | 0.00 | 380-964 / 1349-1482 | 380-965 / 1349-1482 | -0.16 | 1.31 | -0.14 | 0.39 |
| headline-gate-no-hero | and | +100 ms | 1411.46 | 1411.47 | 0.01 | 265-395 / 1353-1412 | 265-395 / 1353-1412 | 0.32 | -0.30 | -0.26 | -0.28 |
| headline-gate-no-hero | and | settled | 1411.46 | 1411.47 | 0.01 | 265-395 / 1353-1412 | 265-395 / 1353-1412 | 0.32 | -0.30 | -0.26 | -0.28 |
| headline-gate-no-hero | then | +100 ms | 1411.46 | 1411.47 | 0.01 | 419-580 / 1353-1412 | 419-580 / 1353-1412 | -0.14 | 0.16 | -0.26 | -0.40 |
| headline-gate-no-hero | then | settled | 1411.46 | 1411.47 | 0.01 | 419-580 / 1353-1412 | 419-580 / 1353-1412 | -0.14 | 0.16 | -0.26 | -0.40 |
| headline-gate-no-hero | it | +100 ms | 1411.46 | 1411.47 | 0.01 | 607-649 / 1352-1412 | 607-649 / 1352-1411 | 0.36 | 0.13 | -0.36 | -0.58 |
| headline-gate-no-hero | it | settled | 1411.46 | 1411.47 | 0.01 | 607-649 / 1352-1412 | 607-649 / 1352-1411 | 0.36 | 0.13 | -0.36 | -0.58 |
| headline-gate-no-hero | was | +100 ms | 1411.46 | 1411.47 | 0.01 | 670-816 / 1369-1412 | 670-816 / 1369-1413 | -0.09 | 0.45 | 0.15 | 0.56 |
| headline-gate-no-hero | was | settled | 1411.46 | 1411.47 | 0.01 | 670-816 / 1369-1412 | 670-816 / 1369-1413 | -0.09 | 0.45 | 0.15 | 0.56 |
| headline-urdu | یہ | +100 ms | 1118.54 | 1118.54 | 0.00 | 521-559 / 1101-1150 | 522-559 / 1101-1150 | 0.64 | 0.44 | -0.26 | -0.30 |
| headline-urdu | یہ | settled | 1118.54 | 1118.54 | 0.00 | 521-559 / 1101-1150 | 522-559 / 1101-1150 | 0.64 | 0.44 | -0.26 | -0.30 |
| headline-urdu | 50 | +100 ms | 1470.90 | 1471.12 | 0.22 | 623-949 / 1270-1474 | 623-949 / 1270-1474 | 0.10 | -0.43 | 0.05 | 0.05 |
| headline-urdu | 50 | settled | 1460.02 | 1460.02 | 0.01 | 623-949 / 1259-1463 | 623-949 / 1259-1463 | 0.10 | -0.43 | -0.07 | -0.07 |
| headline-urdu | فیصد | +100 ms | 1470.90 | 1471.11 | 0.22 | 110-537 / 1166-1499 | 110-537 / 1166-1499 | 0.46 | -0.40 | 0.02 | 0.36 |
| headline-urdu | فیصد | settled | 1460.02 | 1460.02 | 0.00 | 110-537 / 1155-1488 | 110-537 / 1155-1488 | 0.46 | -0.40 | -0.10 | 0.24 |
| headline-urdu | ہے | +100 ms | 1538.32 | 1538.32 | 0.00 | 489-592 / 1493-1574 | 488-592 / 1493-1574 | -0.60 | -0.12 | 0.44 | -0.40 |
| headline-urdu | ہے | settled | 1538.32 | 1538.32 | 0.00 | 489-592 / 1493-1574 | 488-592 / 1493-1574 | -0.60 | -0.12 | 0.44 | -0.40 |
| headline-japanese | 今日は | +100 ms | 1245.58 | 1245.58 | 0.00 | 423-656 / 1178-1252 | 423-656 / 1178-1252 | 0.20 | 0.00 | -0.14 | -0.30 |
| headline-japanese | 今日は | settled | 1245.58 | 1245.58 | 0.00 | 423-656 / 1178-1252 | 423-656 / 1178-1252 | 0.20 | 0.00 | -0.14 | -0.30 |
| headline-japanese | 3回 | +100 ms | 1485.31 | 1485.54 | 0.22 | 331-736 / 1268-1507 | 331-736 / 1268-1507 | 0.35 | -0.22 | 0.02 | 0.20 |
| headline-japanese | 3回 | settled | 1474.43 | 1474.44 | 0.01 | 331-736 / 1257-1496 | 331-736 / 1257-1496 | 0.35 | -0.22 | -0.10 | 0.08 |
| headline-japanese | 走った | +100 ms | 1567.84 | 1567.84 | 0.00 | 423-653 / 1501-1574 | 423-653 / 1501-1574 | 0.28 | 0.36 | 0.28 | -0.40 |
| headline-japanese | 走った | settled | 1567.84 | 1567.84 | 0.00 | 423-653 / 1501-1574 | 423-653 / 1501-1574 | 0.28 | 0.36 | 0.28 | -0.40 |
| headline-short-words | stop | +100 ms | 1299.07 | 1299.08 | 0.01 | 216-374 / 1246-1315 | 216-374 / 1246-1315 | -0.07 | 0.20 | -0.22 | -0.40 |
| headline-short-words | stop | settled | 1299.07 | 1299.08 | 0.01 | 216-374 / 1246-1315 | 216-374 / 1246-1315 | -0.07 | 0.20 | -0.22 | -0.40 |
| headline-short-words | wasting | +100 ms | 1299.07 | 1299.08 | 0.01 | 396-681 / 1240-1316 | 397-681 / 1240-1316 | 1.00 | -0.27 | 0.03 | -0.03 |
| headline-short-words | wasting | settled | 1299.07 | 1299.08 | 0.01 | 396-681 / 1240-1316 | 397-681 / 1240-1316 | 1.00 | -0.27 | 0.03 | -0.03 |
| headline-short-words | time | +100 ms | 1299.07 | 1299.08 | 0.01 | 705-864 / 1240-1300 | 705-864 / 1240-1300 | -0.14 | -0.05 | 0.03 | -0.01 |
| headline-short-words | time | settled | 1299.07 | 1299.08 | 0.01 | 705-864 / 1240-1300 | 705-864 / 1240-1300 | -0.14 | -0.05 | 0.03 | -0.01 |
| headline-short-words | NOW | +100 ms | 1521.77 | 1521.78 | 0.01 | 224-868 / 1321-1525 | 224-867 / 1321-1525 | 0.10 | -0.66 | 0.17 | 0.17 |
| headline-short-words | NOW | settled | 1521.77 | 1521.78 | 0.01 | 224-868 / 1321-1525 | 224-867 / 1321-1525 | 0.10 | -0.66 | 0.17 | 0.17 |
| headline-long-hero-fit | we | +100 ms | 1307.70 | 1307.71 | 0.01 | 346-429 / 1274-1308 | 346-429 / 1274-1308 | 0.18 | -0.44 | 0.36 | -0.45 |
| headline-long-hero-fit | we | settled | 1307.70 | 1307.71 | 0.01 | 346-429 / 1274-1308 | 346-429 / 1274-1308 | 0.18 | -0.44 | 0.36 | -0.45 |
| headline-long-hero-fit | finally | +100 ms | 1307.70 | 1307.71 | 0.01 | 447-622 / 1261-1321 | 447-622 / 1261-1321 | 0.18 | -0.01 | 0.49 | 0.20 |
| headline-long-hero-fit | finally | settled | 1307.70 | 1307.71 | 0.01 | 447-622 / 1261-1321 | 447-622 / 1261-1321 | 0.18 | -0.01 | 0.49 | 0.20 |
| headline-long-hero-fit | got | +100 ms | 1307.70 | 1307.71 | 0.01 | 640-734 / 1265-1321 | 640-734 / 1265-1321 | 0.33 | 0.45 | -0.50 | -0.23 |
| headline-long-hero-fit | got | settled | 1307.70 | 1307.71 | 0.01 | 640-734 / 1265-1321 | 640-734 / 1265-1321 | 0.33 | 0.45 | -0.50 | -0.23 |
| headline-long-hero-fit | 1,000,000,000 | +100 ms | 1434.51 | 1434.52 | 0.01 | 68-1011 / 1331-1458 | 69-1010 / 1331-1458 | 0.91 | -1.22 | 0.31 | -0.11 |
| headline-long-hero-fit | 1,000,000,000 | settled | 1428.89 | 1428.90 | 0.01 | 68-1011 / 1325-1452 | 69-1010 / 1325-1453 | 0.91 | -1.22 | -0.07 | 0.51 |
| headline-long-hero-fit | views | +100 ms | 1503.51 | 1503.52 | 0.01 | 456-623 / 1456-1504 | 456-623 / 1456-1504 | 0.13 | 0.21 | -0.32 | -0.29 |
| headline-long-hero-fit | views | settled | 1503.51 | 1503.52 | 0.01 | 456-623 / 1456-1504 | 456-623 / 1456-1504 | 0.13 | 0.21 | -0.32 | -0.29 |
| headline-override-hero | the | +100 ms | 1291.48 | 1291.48 | 0.01 | 371-488 / 1233-1292 | 371-487 / 1233-1292 | -0.35 | -0.63 | -0.27 | -0.41 |
| headline-override-hero | the | settled | 1291.48 | 1291.48 | 0.01 | 371-488 / 1233-1292 | 371-487 / 1233-1292 | -0.35 | -0.63 | -0.27 | -0.41 |
| headline-override-hero | BEST | +100 ms | 1291.48 | 1291.48 | 0.01 | 514-707 / 1232-1292 | 514-707 / 1232-1292 | 0.27 | -0.25 | -0.37 | -0.41 |
| headline-override-hero | BEST | settled | 1291.48 | 1291.48 | 0.01 | 514-707 / 1232-1292 | 514-707 / 1232-1292 | 0.27 | -0.25 | -0.37 | -0.41 |
| headline-override-hero | part | +100 ms | 1482.69 | 1482.59 | -0.10 | 292-795 / 1303-1538 | 291-797 / 1303-1538 | -1.39 | 1.56 | 0.01 | -0.20 |
| headline-override-hero | part | settled | 1476.91 | 1476.92 | 0.01 | 292-795 / 1297-1532 | 291-797 / 1297-1532 | -1.39 | 1.56 | -0.21 | -0.42 |
| headline-override-plain | the | +100 ms | 1408.06 | 1408.07 | 0.01 | 248-364 / 1350-1409 | 248-364 / 1350-1409 | 0.18 | -0.11 | 0.14 | 0.00 |
| headline-override-plain | the | settled | 1408.06 | 1408.07 | 0.01 | 248-364 / 1350-1409 | 248-364 / 1350-1409 | 0.18 | -0.11 | 0.14 | 0.00 |
| headline-override-plain | BEST | +100 ms | 1408.06 | 1408.08 | 0.01 | 395-627 / 1337-1409 | 395-627 / 1337-1409 | 0.07 | -0.14 | -0.14 | -0.19 |
| headline-override-plain | BEST | settled | 1408.06 | 1408.08 | 0.01 | 395-627 / 1337-1409 | 395-627 / 1337-1409 | 0.07 | -0.14 | -0.14 | -0.19 |
| headline-override-plain | part | +100 ms | 1408.06 | 1408.08 | 0.01 | 657-831 / 1345-1428 | 658-831 / 1345-1428 | 0.57 | 0.18 | 0.36 | 0.34 |
| headline-override-plain | part | settled | 1408.06 | 1408.08 | 0.01 | 657-831 / 1345-1428 | 658-831 / 1345-1428 | 0.57 | 0.18 | 0.36 | 0.34 |

**Commands** (worktree root, Bun 1.4.4)

```sh
bun test apps/media/src/caption-block-ass.test.ts                                   # 15 pass
CAPTION_BLOCK_PARITY=1 bun test apps/media/src/caption-block-render.test.ts         # 13 pass, ~8 s, prints the table
bun test apps/media/src/caption-ass.test.ts                                         # 48 pass, 24 snapshots
bun apps/media/scripts/caption-frames.ts "$TMPDIR/frames" headline-en                # one case: 21 frames + frames.json
bun .scratch/dynamic-captions/references/budget-03b.ts "$TMPDIR/budget" 5           # budget table
```

**Verification**

- `cd apps/media && bun test src/caption scripts/`: 149 pass, 0 fail, 24 snapshots.
- `bun run lint`: exit 0 (20 warnings and 1 info, all pre-existing and none in changed files; `biome check` on the changed files is clean).
- `bun run typecheck`: 15 of 15 tasks pass (the `import.meta.dir` error in `dynamic-caption-fixtures.ts` is fixed with `fileURLToPath(new URL(..., import.meta.url))`).
- `bun run test`: 14 of 14 tasks, exit 0. media 1015, web 1140, validators 890, composition-plan 129, caption-fonts 115, services 1629, api 984, api-client 232, mcp-core 169; 0 failures anywhere.
- Frames: all 9 fixture cases × 3 backgrounds × 7 moments rendered (189 frames) and checked by eye. Lead, hero and tail rows; RTL order in the Urdu hero; Japanese fallback; the no-hero single row; the long hero clamped by fit.

