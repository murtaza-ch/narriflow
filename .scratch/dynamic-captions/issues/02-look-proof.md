# 02 - Look proof

**What to build:** A hand-built Headline frame (ASS + HTML) proves the target look and measures the render budget (spec section 8, gate G2).

**Blocked by:** None

**Status:** done

Spec: [../spec.md](../spec.md). Follow the spec; where a ticket and the spec disagree, the spec wins.

## Acceptance

- [x] `references/proof/headline.ass` and `references/proof/headline.html` render Headline with the phase 2 gradient and the hero blur entrance over a real talking-head frame, using the worker's ffmpeg/libass and the vendored fonts.
- [x] Frames at onset, +100 ms and settled are saved in `references/proof/`.
- [x] Render time of a 20 s 1080x1920 clip with the heaviest look vs Bold Pop is measured and recorded here; events per cue are counted.
- [x] G2 (Sol) recorded under `## Comments`.
- [ ] `bun run lint`, `bun run typecheck`, `bun run test` pass (Bun 1.4.4). No PostgreSQL or heavy suites.

## Comments

### Opus, 2026-11-19: proof built, G2 pending

Nothing in `apps/` or `packages/` changed. Everything is in `references/proof/`:

| File | What it is |
| --- | --- |
| `layout.js` | Throwaway placement shared by both painters: spec 5.6 rules 1 to 9 for Headline, `slide` poses (5.7), duration cap. Plain JS so Bun and the browser load the same file. |
| `build.ts` | Measures each word alone with `layoutCaptionLine` (HarfBuzz), places it with `layout.js`, writes `headline.ass`, `cues.json` (the geometry) and `boldpop.ass` (the same words through the real `renderCaptionTrack`). `build.ts 80 1` writes the `headline-s80.ass` variant. |
| `headline.ass` | 12 cues, one every 1.65 s, each visible 1.6 s. One event per word per layer: `\an5` + `\move`/`\pos` + `\org`; shadow layer 0, text layer 1; hero text split into `\clip` bands. |
| `headline.html` | Same cues. Canvas `measureText` at 100 px, the same `layout.js`, absolutely placed words, `background-clip: text` gradient, playhead-driven poses (`?t=0.35` freezes, `&shot` gives the bare 1080x1920 stage). Serve the worktree root over HTTP, because `file://` blocks the fonts and the module. |
| `render.sh` | Backdrop, the three frames, and the budget runs. Videos go outside the repo. |
| `backdrop.jpg` | `green-studio.webp` (preset backdrops) scaled from 512x910 to 1080x1920. |
| `frame-onset.png`, `frame-100ms.png`, `frame-settled.png` | libass frames of cue 1 at 0.2667 s, 0.35 s and 1.2 s. "Onset" is the first 30 fps frame after the hero's 0.25 s onset (17 ms into the entrance). At exactly 0.25 s both painters draw the hero at opacity 0. |
| `html-frame-*.jpg` | The HTML page at the same three times (headless Chrome). |
| `frame-settled-s80.png` | Variant with S = 80 and minor = 1.0, for the hierarchy question below. |
| `cues-settled.jpg` | All 12 cues settled, cropped. |

**Values used (spec section 6, Headline phase 2).** S = 56, minor 0.75 S (42 px), Inter SemiBold support, Inter ExtraBold hero, fill 0.80 clamped to 2.5 to 4.2 S, rowGap 0.06 S (3.36 px, every row gap in every cue measures 3.36 px of ink to ink), gradient `#A5EBC5` to `#36B780` over the hero row's rest ink box, shadow black 65 % with CSS 6 px blur (Gaussian sigma 3 px) and 2 px down, scaled by px / S, no outline. The motion is `slide` exactly as in 5.7, with the duration cap. Word gap 0.232 em, the Inter SemiBold space, stands in for `CAPTION_BLOCK.wordGapEm`. The brief asked for "with" at 56 px, but the spec makes it minor (0.75 S); the spec won.

**Budget.** Machine: Apple M1 Pro, 8 cores; local ffmpeg 7.1.5 + libass 0.17.5 (worker: ffmpeg 7.1.5 + libass 0.17.3). Input: the still backdrop looped to 20 s at 30 fps, 1080x1920. Encode settings are the worker defaults (`clip-render-attempt.ts`: libx264 veryfast, crf 21, yuv420p). "filter" stops after the `ass` filter (`-f null`) to isolate libass. Each value is the median of 3 interleaved runs. Other sessions kept the load average between 17 and 20, so the CPU column is the steadier signal.

| Mode | None | Bold Pop | Headline | Headline / Bold Pop |
| --- | --- | --- | --- | --- |
| encode, wall s | 1.49 | 1.64 | 1.73 | **1.05x** |
| encode, CPU s (user + sys) | 6.17 | 7.83 | 7.76 | 0.99x |
| filter only, wall s | 1.34 | 1.38 | 1.40 | 1.01x |
| filter only, CPU s | 1.38 | 2.47 | 2.50 | 1.01x |

An earlier run under lighter load, timed with a wall-clock timer only, gave encode 1.384 / 1.463 / 1.551 s (1.06x) and filter 1.319 / 1.351 / 1.384 s (1.02x). The budget is at most 1.35x, so G2's budget half passes with room to spare. A still background makes the encode cheap, so these ratios are an upper bound. On real footage, decode and x264 take a bigger share, and libass work is the same whatever the background.

**Events per cue.** Headline averages 38.8 (466 events over 12 cues, from 30 to 66 per cue). Bold Pop averages 14.7 (176 over 12). Each support word is 2 events (shadow, text). Each hero word is 1 shadow event plus 23 to 32 gradient bands (the bands cover the ink, the 0.12 em travel, and 2 blur sigmas of spill on each side). Bands are per word, so 2-word heroes double them: "I made 20 dollars" has 54 events and "got 1 million views" has 66. Every cue stays under the 120-event budget. Without the gradient (phase 1, flat hero), a cue is 6 to 10 events.

**Parity, ASS vs HTML.** Canvas measurement and HarfBuzz agree exactly: max |Δ| is 0.00 px for baselines and sizes over all 12 cues (the report under the page). Rendered ink on the settled frame agrees within 1 to 2 px. Hero letters span x 126 to 967 (libass) and 127 to 966 (Chrome), hero ink rows 1069 to 1212 and 1068 to 1212, and "with" and "captions" land on the same rows and columns. Caption-region PSNR is 34.8 / 28.1 / 27.0 dB at onset / +100 ms / settled, from antialiasing plus the expected gradient offset during travel.

**libass and CSS limits found (inputs for 03b, 03c and 06):**

1. **libass does not kern by default.** HarfBuzz measurement and CSS both kern. Without a `Kerning: yes` line in `[Script Info]`, libass drew "Accurate" about 10 px wider than the layout ("Ac" alone is 6 px). With the line, libass matches the layout to 1 px. The block painter needs that header. The classic painter (`caption-ass.ts`) measures word boxes kerned but omits the header, so its pills and overlays probably drift by kerning amounts on pairs like "AV". That is out of scope here; turning kerning on would change the ticket 00 snapshot.
2. **Gradient bands seam on 4:2:0 output** unless every band edge falls on an even row. A band edge on an odd row makes two bands each half-cover one chroma sample, and the background's chroma shows through as a grey line. `build.ts` snaps band edges to even rows. Ticket 06 must do the same, in output pixels.
3. Bands are screen-fixed and the CSS gradient travels with the text, so the hero's colours differ by up to 0.12 em (24 px) at onset, gone by 150 ms. The spec already accepts this.
4. CSS paints `text-shadow` over a `background-clip: text` fill, so the page draws each shadow as its own element behind the word, mirroring the ASS layers. 03c needs the same split.
5. Event times are in centiseconds, and `\move` is linear only. Neither matters for `slide`.

**How close to reference 01 (my judgement, for Sol to check).** Colour, gradient direction, soft shadow, ink-tight stacking and the hero's 80 % width all match the reference. Hierarchy does not. With the spec's S = 56 and minor 0.75, support words are 21 % to 29 % of the hero size. In reference 01 they are about 55 % to 60 %: at 1080 wide the hero is about 200 px and "with" and "captions" about 115 to 125 px. The reference also tracks the hero tighter (about -0.03 em) and uses heavier support. Mixing minor and body sizes in one row ("the secret is", "I made", "your time" in `cues-settled.jpg`) looks uneven. `frame-settled-s80.png` (S = 80, minor = 1.0, hero at the 2.5 S floor) is visibly closer and keeps rule 1. Matching the reference's own ratio (about 1.6x) would break rule 1 (at least 2.2x). Suggested for the G2 decision: Headline S about 80, minor = body size, hero letter spacing about -0.03 em.

**Commands** (from the worktree root):

```sh
bun .scratch/dynamic-captions/references/proof/build.ts          # headline.ass, boldpop.ass, cues.json
bun .scratch/dynamic-captions/references/proof/build.ts 80 1     # headline-s80.ass (variant)
bash .scratch/dynamic-captions/references/proof/render.sh "$TMPDIR/narriflow-proof"   # backdrop, frames, budget (3 runs, RUNS=n to change)
# frame at an exact time (what render.sh does per frame):
ffmpeg -i .scratch/dynamic-captions/references/proof/backdrop.jpg \
  -vf "settb=1/1000000,setpts=0.35/TB,ass=.scratch/dynamic-captions/references/proof/headline.ass:fontsdir=packages/caption-fonts/fonts" \
  -frames:v 1 frame-100ms.png
# budget run, per mode and track:
ffmpeg -loop 1 -framerate 30 -t 20 -i backdrop.jpg -vf "ass=headline.ass:fontsdir=packages/caption-fonts/fonts" \
  -c:v libx264 -preset veryfast -crf 21 -pix_fmt yuv420p -r 30 out.mp4      # encode
ffmpeg -loop 1 -framerate 30 -t 20 -i backdrop.jpg -vf "ass=headline.ass:fontsdir=packages/caption-fonts/fonts" -f null -   # filter only
# HTML frames:
python3 -m http.server 8765 --bind 127.0.0.1
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1080,1920 --virtual-time-budget=4000 --screenshot=html-settled.png \
  "http://127.0.0.1:8765/.scratch/dynamic-captions/references/proof/headline.html?shot&t=1.2"
```

**Verification.** `bun run lint` passes: 0 errors, and the remaining warnings are pre-existing ones outside `references/proof/`. Biome checks `.scratch`, so the proof scripts are kept lint-clean. Per the orchestrator, `typecheck` and `test` were not run for this ticket, because no code in `apps/` or `packages/` changed. That box stays open until the closing pass.

### Opus, 2026-11-19: G2 follow-up (adopted recipe)

Sol's G2 failed only because the proof did not use the adopted recipe. The proof now draws it in both painters, and nothing in `apps/` or `packages/` changed. `headline-s80.ass` and `frame-settled-s80.jpg` are deleted (superseded). All frames are now JPEG quality 85 (`sips`), and `render.sh` writes them directly.

**Recipe (both painters, from `layout.js`).** S = 80. Minor and body words are Inter SemiBold at 80 px, white. The hero is Inter ExtraBold with letter spacing −0.03 em. The tracking is measured before the fill is solved (HarfBuzz `layoutCaptionLine` with −0.03 in the worker, Canvas `letterSpacing` in the page, the advance excluding the trailing spacing). Fill is 0.80 of the frame width, clamped to 2.2 to 3.4 S (176 to 272 px) before fit. rowGap is 0.06 S, and every row gap in every cue measures 4.80 px ink to ink. The one exception is 4.66 px in "the secret is consistency", where the clamped 176 px hero is wider than the fit width and the block scale is 0.971. The gradient runs from `#A5EBC5` at 0 % to `#36B780` at 100 % of the hero's rest ink box. The shadow is a separate black 65 % layer with a 6 px blur and 2 px down at S, scaled by px / S. The block is centred at x 50 %, y 60 %. The entrance is `slide` as before. Hero sizes per cue are 171 to 272 px. Rule 1 holds after fit (minimum 2.2x body).

**Gradient bands.** Each band is exactly 8 px, and every edge falls on an even row. A word over 48 bands or a cue over 120 events throws in `build.ts`. The maximum is **37 bands per hero word** ("wasting") and **68 Dialogue events per cue** ("got 1 million views"). There are 505 events over 12 cues (mean 42), against 176 for Bold Pop.

**New finding: libass drops kerning under `\fsp`.** Any glyph with a non-zero `\fsp` is drawn unkerned, and `Kerning: yes` does not change this. With `\fsp-6.18`, "AVAV" is pixel-identical whether Kerning is yes or no, and it is 65 px wider kerned at `\fsp0`. HarfBuzz and CSS keep kerning under letter spacing. A uniform `\fsp` therefore drew "Accurate" 10 px wider than Chrome (Δ left 5 to 6 px, outside tolerance). `build.ts` now gives each glyph of a tracked word its own `\fsp`: the tracking plus that glyph's kerning, which is its kerned advance in the word minus its advance alone. For example, `{\fsp-11.41}A{\fsp-6.18}c…`. The event count stays the same. **Input for 03b/06:** any tracked word (hero −0.03 em, and classic presets with `letterSpacing ≠ 0`) needs per-glyph `\fsp` like this, or it drifts by the kerning amounts. The classic painter's uniform `\fsp` probably has the same drift today.

**Parity, measured** (`parity.ts`). For each word already spoken, the script renders that word alone, without its shadow, on flat black: libass through ffmpeg (that word's Layer 1 events), Chrome through `&flat&noshadow&only=N`. The ink box is every pixel whose brightest channel reaches half the image's peak. Both painters draw the same glyphs, so the ink-bottom delta is the baseline delta. Δ = HTML − libass, in px:

| Moment | Word | libass ink x / y | HTML ink x / y | Δ baseline | Δ left | Δ right | Δ top | max \|Δ\| |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| onset (0.2667 s) | with | 462-614 / 1004-1063 | 462-615 / 1003-1063 | 0 | 0 | 1 | −1 | 1 |
| onset | Accurate | 113-967 / 1090-1240 | 114-966 / 1089-1241 | 1 | 1 | −1 | −1 | 1 |
| +100 ms (0.35 s) | with | 462-614 / 1004-1063 | 462-615 / 1003-1063 | 0 | 0 | 1 | −1 | 1 |
| +100 ms | Accurate | 108-968 / 1076-1228 | 110-967 / 1076-1229 | 1 | 2 | −1 | 0 | 2 |
| settled (1.2 s) | with | 462-614 / 1004-1063 | 462-615 / 1003-1063 | 0 | 0 | 1 | −1 | 1 |
| settled | Accurate | 108-968 / 1068-1220 | 109-967 / 1067-1220 | 0 | 1 | −1 | −1 | 1 |
| settled | captions | 384-696 / 1225-1300 | 383-696 / 1224-1300 | 0 | −1 | 0 | −1 | 1 |

Every word is within tolerance: baselines ≤ 1 px (limit 2), left edges ≤ 2 px (limit 4), ink bounds ≤ 2 px (limit 4). *(Superseded by "G2 parity fix" below: this Δ baseline column is a thresholded raster ink-bottom delta, not a baseline, and the ink boxes were taken from gradient-filled, faded renders.)* "captions" first appears at 0.75 s, so it is measured settled only. The Canvas layout and the HarfBuzz geometry agree exactly (max |Δ| 0.00 px for baselines and sizes, page report).

**Budget, re-measured** because the bands, sizes and event count changed. Same machine, method and `render.sh` as above. Load average was 12 to 20 throughout, so the wall times are noisy and the CPU column is steadier.

| Pass | Mode | None | Bold Pop | Headline | Headline / Bold Pop |
| --- | --- | --- | --- | --- | --- |
| median of 3 | encode, wall s | 1.77 | 1.96 | 2.27 | **1.16x** |
| median of 3 | encode, CPU s | 6.08 | 7.84 | 7.91 | 1.01x |
| median of 3 | filter only, wall s | 1.71 | 1.49 | 1.91 | 1.28x |
| median of 3 | filter only, CPU s | 1.53 | 2.51 | 2.90 | 1.16x |
| median of 5 | encode, wall s | 1.43 | 1.67 | 1.81 | **1.08x** |
| median of 5 | encode, CPU s | 5.77 | 7.40 | 7.74 | 1.05x |
| median of 5 | filter only, wall s | 1.40 | 1.46 | 1.56 | 1.07x |
| median of 5 | filter only, CPU s | 1.40 | 2.43 | 2.71 | 1.12x |

Both passes stay under the 1.35x budget. The libass share grew compared with the S = 56 proof: filter CPU is now 1.12 to 1.16x, up from 1.01x. The hero glyphs are larger, and there are 39 more band events.

**Files.** Changed: `layout.js` (recipe), `build.ts` (tracked measurement, per-glyph `\fsp`, fixed 8 px bands with the 48 and 120 guards, the variant removed), `headline.html` (tracking, side padding so negative tracking does not clip the gradient's last glyph, `&flat`, `&noshadow`, `&only=N`), `render.sh` (JPEG q85, HTML frames, contact sheet), `headline.ass`, `cues.json`, the six frames and `cues-settled.jpg` (all 12 cues settled, 4x3). `boldpop.ass` is unchanged. New: `parity.ts`. Deleted: `headline-s80.ass`, `frame-settled-s80.jpg`.

```sh
bun .scratch/dynamic-captions/references/proof/build.ts                          # headline.ass, boldpop.ass, cues.json
bash .scratch/dynamic-captions/references/proof/render.sh "$TMPDIR/narriflow-proof"   # frames, contact sheet, budget (BUDGET=0 skips, RUNS=n)
bun .scratch/dynamic-captions/references/proof/parity.ts "$TMPDIR/narriflow-parity"  # parity table
```

#### G2 parity fix (Opus, 2026-11-19)

Sol's re-check passed the visuals but failed the parity evidence on two points. First, the "Δ baseline" above is a raster ink-bottom delta, so it moves with rasterisation, blur and gradient brightness. Second, `inkBox` passed empty renders: a black image has peak 0, so every pixel counted as ink. `parity.ts` is rewritten to measure the two things separately, and `headline.html` gained what it needs. The earlier table stays above for history. No painter bug turned up, so neither painter's output changed.

**Baseline, from layout and pose (tolerance 2 px).**
- HTML: each word's text now starts with a zero-size inline-block baseline anchor (`.anchor`). With `?t=`, the page writes each visible word's anchor rect, pose transform included, to `<script id="metrics">`. `parity.ts` loads the frame exactly as `render.sh` shoots it (`?shot&t=`) and reads the metrics from the same Chrome run that takes the screenshot (`--screenshot` plus `--dump-dom`). The anchor is invisible: the three frames differ from the pre-anchor renders by at most 1 level in 255, so the committed `html-frame-*.jpg` were not regenerated.
- libass: computed from the word's Layer 1 Dialogue line alone, without reading `cues.json` or `layout.js`. The model is: `\an5` centres the line box on `\pos`; the box is winAscent + winDescent, read from the font file's OS/2 table (matched by name ID 4, as libass matches `\fn`) and scaled to sum to `\fs`; so the baseline is y + (ascent − descent) / 2. `\move` is interpolated at libass's integer-ms clock, which is what ffmpeg feeds it: setpts truncates to the 1/1000000 timebase and the ass filter truncates to ms.
- Calibration, done once: libass renders a flat-bottomed "H" (HarfBuzz ink bottom 0 em in both Inter faces) at known `\pos` y values of 1000, 1000.25, 1000.5 and 1000.75, at both event sizes (SemiBold `\fs114.42`, ExtraBold `\fs294.72`). The rendered bottom edge, sub-pixel from stem-column coverage, lands within 0.019 px of the model in all 8 cases. The mean offset (0.007 px) is applied. A 1 px/ms `\move` measures libass's clock at 265.99, 349.99 and 1199.99 ms, against 266, 350 and 1200 modelled.

| Moment | Word | libass t (ms) | libass pose dy | HTML pose dy | libass baseline y | HTML baseline y (DOM) | Δ baseline | Within |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| onset (0.2667 s) | with | 266 | 0.00 | 0.00 | 1062.87 | 1062.86 | −0.01 | yes |
| onset | Accurate | 16 | 22.08 | 21.98 | 1239.80 | 1239.67 | −0.13 | yes |
| +100 ms (0.35 s) | with | 350 | 0.00 | 0.00 | 1062.87 | 1062.86 | −0.01 | yes |
| +100 ms | Accurate | 100 | 8.24 | 8.24 | 1225.96 | 1225.93 | −0.03 | yes |
| settled (1.2 s) | with | 1200 | 0.00 | 0.00 | 1062.87 | 1062.86 | −0.01 | yes |
| settled | Accurate | 950 | 0.00 | 0.00 | 1217.72 | 1217.69 | −0.03 | yes |
| settled | captions | 450 | 0.00 | 0.00 | 1283.92 | 1283.91 | −0.02 | yes |

The largest gap, −0.13 px at onset, is clock quantisation. libass sees 16 ms into the hero's entrance and the page sees 16.67 ms, so libass is 0.10 px further back on the 24.7 px rise. The `slide` entrance has no scale term, so the pose here is the offset alone; the DOM rect would include a scale if one were added. The remaining −0.01 to −0.03 px is the page's 1/64 px layout unit.

**Ink bounds, from solid masks (tolerance 4 px, left edge 4 px).** Each word renders alone on flat black, solid white at full opacity, with no shadow and no gradient. For libass, the mask is the word's first Layer 1 event with `\clip`, `\fade` and the colour removed; for HTML, it is `&flat&mask&only=N`. Position and blur still follow the pose. Ink is every pixel at 50 % coverage or more (value 128), a fixed threshold, so neither gradient brightness nor opacity can move the contour. Every render is checked first. A zero-peak image, a mask under 50 pixels, a mask over 50 % of the frame, or a wrong-size buffer throws a named error. All of these, plus a valid 200x100 block, were exercised on synthetic buffers. Each HTML mask run's DOM baseline must also match the frame run's within 1/64 px.

| Moment | Word | libass ink x / y | HTML ink x / y | Δ left | Δ right | Δ top | Δ bottom | max \|Δ\| | Within |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| onset | with | 462-614 / 1004-1063 | 462-615 / 1003-1063 | 0 | 1 | −1 | 0 | 1 | yes |
| onset | Accurate | 111-968 / 1090-1242 | 112-967 / 1089-1242 | 1 | −1 | −1 | 0 | 1 | yes |
| +100 ms | with | 462-614 / 1004-1063 | 462-615 / 1003-1063 | 0 | 1 | −1 | 0 | 1 | yes |
| +100 ms | Accurate | 108-968 / 1076-1228 | 109-967 / 1076-1229 | 1 | −1 | 0 | 1 | 1 | yes |
| settled | with | 462-614 / 1004-1063 | 462-615 / 1003-1063 | 0 | 1 | −1 | 0 | 1 | yes |
| settled | Accurate | 108-968 / 1068-1220 | 109-967 / 1067-1220 | 1 | −1 | −1 | 0 | 1 | yes |
| settled | captions | 384-696 / 1225-1300 | 383-696 / 1224-1300 | −1 | 0 | −1 | 0 | 1 | yes |

**Result.** Nothing breaches a tolerance. Baselines agree within 0.13 px (limit 2). Solid-mask ink bounds and left edges agree within 1 px (limit 4). Compared with the earlier table, only the entering hero moved. At onset, "Accurate" grew by 1 to 2 px per side (libass 113-967 / 1090-1240 became 111-968 / 1090-1242). At +100 ms, its HTML left edge moved from 110 to 109. The old boxes were thresholded at half the peak of a faded, gradient-filled, blurred word, so their contour sat inside the true 50 % coverage edge. Settled words are unchanged.

**Files.** `parity.ts` (rewritten), `headline.html` (baseline anchor, `&mask`, the `metrics` script). Same command as above: `bun .scratch/dynamic-captions/references/proof/parity.ts "$TMPDIR/narriflow-parity"`, about 20 s. The `bun run lint` scope is clean for `references/proof/` (`biome check` passes).

### G2 verdict (orchestrator, 2026-11-19)

Sol review 1: fail, recipe not the adopted one. Sol review 2: visuals pass on all six earlier findings; fail only on the parity method (ink-bottom used as baseline, empty renders could pass). Both fixed in the "G2 parity fix" entry above: baselines from layout and pose within 0.13 px, solid-mask ink bounds within 1 px. G2 closed as passed. The parity method in `parity.ts` (layout baselines, calibrated libass baselines, solid masks, rejection of empty renders) is the model for the ticket 03b/03c parity checks.
