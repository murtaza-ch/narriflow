# 02 - Look proof

**What to build:** A hand-built Headline frame (ASS + HTML) proves the target look and measures the render budget (spec section 8, gate G2).

**Blocked by:** None

**Status:** claimed

Spec: [../spec.md](../spec.md). Follow the spec; where a ticket and the spec disagree, the spec wins.

## Acceptance

- [x] `references/proof/headline.ass` and `references/proof/headline.html` render Headline with the phase 2 gradient and the hero blur entrance over a real talking-head frame, using the worker's ffmpeg/libass and the vendored fonts.
- [x] Frames at onset, +100 ms and settled are saved in `references/proof/`.
- [x] Render time of a 20 s 1080x1920 clip with the heaviest look vs Bold Pop is measured and recorded here; events per cue are counted.
- [ ] G2 (Sol) recorded under `## Comments`.
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
