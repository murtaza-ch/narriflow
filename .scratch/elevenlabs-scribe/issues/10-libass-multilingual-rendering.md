# 10 — Multilingual burn-in: font precedence, shaped geometry, RTL

**What to build:** Spec D11/D12 in `apps/worker/src/caption-glyphs.ts` and `caption-ass.ts`: locale font precedence by effective language; HarfBuzz-shaped measurement of same-face runs (e.g. `harfbuzzjs` with the vendored font files) replacing per-grapheme advances, giving visual word boxes for pills/plates/emoji/motion in bidi visual order; Nastaliq-aware line metrics; `Encoding -1`; verified RTL karaoke/active-word sweep on the pinned libass (fallback: animated clip). Same typed degradation contract when geometry is unavailable (documented for ticket 11).

**Blocked by:** 08, 09

**Status:** done

**Acceptance:**
- [x] Golden frames rendered with the pinned ffmpeg/libass for: Urdu (Nastaliq, long word, top/bottom), Arabic+numbers, Hebrew, Hindi conjuncts, Bengali, Tamil, Thai, Japanese, Cantonese, Amharic, Georgian, English pill style — inspected and committed as test evidence.
- [x] Worker caption tests green.

## Comments

### Implementation evidence (ticket 10)

Frames: `.scratch/elevenlabs-scribe/evidence/10/*.png` (+ the `.ass` each came from), produced by `bun apps/worker/scripts/caption-frames.ts <dir>` with ffmpeg 8.0.1 / libass 0.17.4 on darwin-arm64 (the Linux image pins libass 0.17.3 / HarfBuzz 10.2.0; the harfbuzzjs WASM is HarfBuzz 15.0.0 — widths only differ if a font's shaping changes between those versions). Every frame was looked at. `before/` holds the same cues rendered by the commit before this ticket.

- **Urdu** (`ur-nastaliq-bottom/top`, `ur-long-word`): Nastaliq (was generic Naskh in `before/`), words right-to-left, pill on the right word, tall pill/line metrics from Nastaliq ink. `ur-generic-arabic-face` shows the same cue with no language.
- **Arabic + numbers + Latin** (`ar-numbers-latin`): `2026` and `Narriflow` read left to right between the Arabic words; libass's order and our geometry agree (pill on `بالعالم`).
- Hebrew, Hindi conjuncts, Bengali, Tamil, Thai, Japanese (JP vs `ja-generic-han` SC), Cantonese (TC), Amharic, Georgian, English pill: all with pills on the right word.

Findings on libass 0.17.4 (all measured with real renders):
1. `Encoding -1` is required: with Encoding 1 an RTL line broken into override-tag runs laid its words out left to right. With -1 it is RTL, and `123`/Latin runs follow UAX #9.
2. `\kf` fills a syllable from its **left edge whatever the direction**, so RTL karaoke swept the wrong way. Fixed with an animated rectangular clip growing from the word's right edge (`\clip` + `\t(\clip)` on a text-only event above the base line); `caption-rtl-render.test.ts` renders real frames and fails on the old behaviour. RTL word under a cue tilt or without geometry: instant highlight (no sweep).
3. Per-grapheme `\ko` (typewriter) **unjoins Arabic** and breaks conjunct/mark shaping (libass splits the shaping run at every tag). Words with any complex/cursive-face part (`letterSpacing: "disabled"`) reveal per word.
4. libass lays a line out with the **Win** ascent/descent (not hhea) of the tallest/deepest face on it; an event holding a single word is centred on its own line box, so overlays/ghosts are shifted to keep the line's baseline.

Design: HarfBuzz (`harfbuzzjs` 1.6.4, WASM in the package, self-initialising) + `bidi-js` 1.1.0 in `packages/caption-fonts/src/shaping.ts`. `layoutCaptionLine` = bidi levels over the whole logical line, runs split at face/level/word, L2 visual order, word boxes in visual order, per-word and per-line ink extents of fallback faces. fontkit now only reads cmaps and OS/2 (its `layout()` hangs/throws on Nastaliq/Gurmukhi/Telugu). `measureCaptionTextEm`, `fontFileAdvanceEm`, `fontkitCannotShape` and `brandFontRenderer().measure` are deleted; brand fonts are measured from their saved file.

### Contract for ticket 11 (Studio mirrors)
- Face order: `orderCaptionFallbackFaces(faces, language, text)` from `@narriflow/caption-fonts/locale-precedence` (pure). Requested/saved face first, then the ordered script faces.
- Base direction: first strong letter of the joined line (`textDirection`, fallback `languageDirection`); words in logical order, drawn in visual order; word boxes from visual order (RTL: first word rightmost).
- Gaps: a space only where `hasSpaceBefore` says so (no-space scripts abut; the pill's extra advance applies only at spaces); letter spacing is 0 for complex/cursive faces and for a gap beside one.
- Line box: tallest Win ascent and deepest Win descent of the faces actually on the line (space = requested face); emoji sits 0.8em above that box top. Pill: top = baseline − (max(capHeight, word fallback ink top) + padTop), bottom = baseline + max(padBottom, word fallback ink bottom + 0.06); plate uses the line's ink. Latin-only lines are unchanged.
- Typed degradation `caption_geometry_unavailable` (`CaptionTrack.geometryUnavailable`): when HarfBuzz cannot open a face (an uploaded **WOFF2** brand font — HarfBuzz reads sfnt only; libass still draws it) the cue keeps its timed base line with colours, reveal, karaoke/typewriter, but no pills, plate, active-word overlay, fit-to-width (a 0.6em/char estimate is used) or word-anchored emoji position.
- Karaoke on an RTL word: sweep from the right edge; typewriter on complex scripts: per word.

### Follow-up: pill/overlay offset in RTL cues (orchestrator review of evidence/10)

**Defect.** In Nastaliq cues the pill sat up to 3.9% of the frame (42 px) right of the word libass drew (`ur-long-word`: pill over the neighbour's last letter, extra gap on the other side); Arabic with harakat 2.1% off; Hebrew, plain Arabic and English exact.

**Root cause (libass 0.17.4 `ass_render.c`, confirmed by measurement).** For a `\pos` event libass does not centre the line's advance box on the point. `compute_string_bbox` takes `x_min = min(root.pos.x)` and `x_max = max(root.pos.x + cluster_advance)` over the *cluster roots*, where `root.pos.x = cluster_pen + root.offset.x` and the root is the cluster's first HarfBuzz glyph. `get_base_point` then puts the bbox middle on `\pos`. Nastaliq (and Arabic with harakat) clusters start with a mark that has a large positive `x_offset` (351 units on `مُحَبَّتُوں`, 213 on `اُردُو`, 595 on the first mark of `خُوبصُورَت`), so the bbox is stretched and the whole line is drawn left of where HarfBuzz widths say. It is not the `\fsp` spaces or the space face: word widths, gaps and the pen sum all matched HarfBuzz to 1 px. Measured with `BorderStyle 3` boxes (advance boxes) and ink in `\an4`/`\an5`/`\an6`: line offset 39-42 px = (Σ cluster-root offsets)/2 at 88 px/em, and per word solo −(xo_first + xo_last mark)/2.

**Fix.** `layoutCaptionLine` now returns `bboxCenterEm`, computed from per-cluster roots (`ShapedRun.clusters`: pen, first-glyph offset, advance; letter spacing added per cluster as libass does), and the serializer places the line's left edge at `anchorX - bboxCenterEm * px` (was `- widthEm / 2`). An event holding one word (active-word overlay, glitch ghosts) is anchored by that word's own bbox, so its `\pos` is `eventX = centerX + (aloneBboxCenter - aloneWidth/2) * px`; pill, clip sweep, emoji use the true advance box (`centerX`), the plate the true line middle (`lineCenterX`). Latin, Hebrew and plain Arabic have no offset roots: their `.ass` is byte-identical to before.

**Measured, pill centre vs the word's ink centre libass draws (px of 1080; `caption-pill-render.test.ts`).**
| sample / word | before | after |
| --- | --- | --- |
| Urdu `مُحَبَّتُوں` | 39.0 | 3.0 |
| Urdu `پاکستان` / `میں` | 19.0 / 22.0 | 2.0 / 1.5 |
| Arabic harakat `مَرْحَبًا` | 23.0 | 1.0 |
| Arabic numbers/Latin (all five words), Hebrew, English | ≤ 5.5 | ≤ 5.5 (unchanged) |
Worst case after: `کی` 17.5 px (1.6%): Nastaliq ink overhangs its advance box (the tail of ی), the pill centres on the advance box.

**Tests.** `apps/worker/src/caption-pill-render.test.ts` (real ffmpeg/libass; fails on the old geometry with the 39 px / 22 px / 23 px offsets above; threshold 2% of frame width, every word of Urdu ×2, Arabic+numbers+Latin, Arabic harakat, Hebrew, English); `packages/caption-fonts/src/shaping.test.ts` pins `bboxCenterEm`. `evidence/10/*` regenerated (new `ur-short-word`, `ar-harakat`); only the Urdu and Arabic-numbers frames changed, `he`/`en-pill` and the other scripts are unchanged. `ar-karaoke` sweep still runs from the word's right edge and stays inside it (`caption-rtl-render.test.ts` green).

**Contract for ticket 11.** Studio draws in CSS and centres on the advance box, so it needs none of this; only the libass serializer shifts. Word boxes (`centerX`, `width`) are advance boxes; `eventX`/`lineCenterX` are libass-event placements. Residual: under a word-pop `\fscx` the overlay scales about its bbox middle, so a marked word's advance centre drifts by (1-s)·shift (a few px); a Nastaliq tail can overhang a short word's pill by a few px.

