# 29 — Bubble lays Urdu out differently in the Studio and the export

**Status:** done
**Area:** `packages/caption-scene/src/templates/bubble.ts` and whatever measurement code it shares; tests in `packages/caption-scene` and `apps/media`. Not `packages/caption-scene/src/emoji/**` (ticket 28).

## Why

The owner asked for the fixable known limits to be fixed. This one is older than emojis and shows
without them: on the Bubble template with Urdu text, the Studio and the export place the words
differently (ticket 12 Evidence: cue 1's right edge is 808 in the export and 904 in the Studio;
the export shows a wider gap between words; an emoji then sits up to 28.27 px apart). Ticket 12's
reading: Bubble measures plain words with letter spacing, and Canvas and HarfBuzz disagree on
those Nastaliq runs. Treat that as a lead, not a finding.

## Deliverables

1. Find the real cause. Build the same Urdu cues with the Studio's measurer and the worker's and
   compare word advances one by one; find which input (letter spacing on a joined script, font
   fallback, shaping features, the space width) makes them differ.
2. Fix it at the cause so both sides lay Bubble's Urdu out the same. If the cause is letter
   spacing applied to a joined script, the right behaviour is probably no letter spacing on
   scripts that join (Arabic, Urdu, Persian), because spacing breaks the joins; check what the
   other templates do and whether any share the fault. Fix every template that shares it, not
   only Bubble.
3. Latin text must not move: the scene JSON for Bubble (and any other template you touch) on the
   demo and real English cues is byte-identical before and after.

## Acceptance

- [x] The measured cause, with the per-word numbers from both measurers before and after.
- [x] Bubble Urdu: Studio and export cue boxes within 1 px, and the emoji parity row for
      bubble-rtl (ticket 12's harness) at or under 1 px. Check Arabic too.
- [x] A rendered Studio frame and export frame side by side, looked at: the words sit the same
      and still join correctly.
- [x] A test that fails on the old code (the two measurers' Bubble Urdu layout agree).
- [x] `bun run --cwd packages/caption-scene test`, `bun run --cwd apps/media test`, typecheck,
      biome on touched paths. Never start a dev server; the owner's is on port 3000 and prototype
      pages may be read from it.

Evidence images go in
`/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-fix-bubble/`.

## Evidence

Done 2026-11-26. Nothing committed, migrated or deployed. Scripts in
`/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/ebb7a967-0e55-48ef-a12d-12a1f400ea69/scratchpad/bubble/`.

### Cause (measured)

Not letter spacing. Bubble already gives non-Latin plain words 0 spacing (`SIMPLE`), and its hero label's 0.01 em is
dropped for joined scripts on all four paths (worker planner `spaced: false`, Studio `measureWord` runs, the DOM's
`CaptionText`, ASS `sp0`): `خیال` at 0.01 em measures 2.224 em on both sides, the same as Rubik with none.

The cause is font fallback inside a word. Rubik (ExtraBold and Black, the only catalog faces with Arabic: 89 code points)
has the Arabic letters but not Urdu's ہ ے ھ ٹ, so the planner draws one Urdu word with Rubik and Noto Nastaliq Urdu
together (`کے` = Rubik `ک` + Nastaliq `ے`). Chrome's Canvas and libass shape each face's run inside the word, so the
letters keep their joining forms across the change. libass, checked by rendering `{nRubik ExtraBold}ک{nNoto Nastaliq
Urdu Regular}ے` through ffmpeg 7.1.5: the initial ک joined to the final ے, ink 130 px wide, the same as the isolated ے
alone (`/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/ebb7a967-0e55-48ef-a12d-12a1f400ea69/scratchpad/bubble/libass/tiles.png`). The worker's
`shapeCaptionRun` shaped every run alone, so it measured the isolated forms: `کے` = 0.923 + 1.409 = 2.332 em against the
0.892 em both renderers draw. The export reserved that width and drew narrower glyphs, hence the wide gaps.

Per word, Bubble's Urdu fixture (em; Studio = Canvas `normal 400 100px` with the Urdu fallback stack, in headless Chrome on
the port-3000 prototype page; export = `SceneMeasurer`):

| Word | Face | Export before | Studio | Export after |
| --- | --- | --- | --- | --- |
| یہ | ExtraBold | 1.170 | 0.541 | 0.541 |
| ایک | ExtraBold | 1.603 | 1.603 | 1.603 |
| خیال | Black | 2.224 | 2.224 | 2.224 |
| میرے | ExtraBold | 2.772 | 2.772 | 2.772 |
| کے | ExtraBold | 2.332 | 0.892 | 0.892 |
| لیے | ExtraBold | 2.446 | 1.022 | 1.022 |
| سب | ExtraBold | 1.814 | 1.814 | 1.814 |
| کاروبار | Black | 2.871 | 2.871 | 2.871 |
| کچھ | ExtraBold | 1.939 | 1.764 | 1.764 |
| بدل | ExtraBold | 1.708 | 1.708 | 1.708 |
| گیا | ExtraBold | 1.202 | 1.202 | 1.202 |
| ہم | ExtraBold | 1.008 | 0.878 | 0.878 |
| نے | ExtraBold | 2.137 | 0.648 | 0.648 |
| مہینے | Black | 3.535 | 2.017 | 2.017 |
| میں | ExtraBold | 1.683 | 1.683 | 1.683 |
| سال | ExtraBold | 1.935 | 1.935 | 1.935 |
| سے | ExtraBold | 2.697 | 1.202 | 1.202 |
| زیادہ | Black | 1.954 | 1.954 | 1.954 |
| کمائے | ExtraBold | 3.727 | 2.116 | 2.116 |
| پیسے | Black | 3.401 | 1.885 | 1.885 |
| پوری | ExtraBold | 2.076 | 2.076 | 2.076 |
| ٹیم | Black | 2.217 | 1.303 | 1.303 |
| کو | ExtraBold | 1.088 | 1.088 | 1.088 |
| بہت | ExtraBold | 2.146 | 1.644 | 1.644 |
| پسند | ExtraBold | 2.137 | 2.137 | 2.137 |
| آیا | Black | 0.985 | 0.985 | 0.985 |
| سچ | ExtraBold | 1.594 | 1.594 | 1.594 |
| کہوں | Black | 2.567 | 2.255 | 2.255 |
| تو | ExtraBold | 0.844 | 0.844 | 0.844 |
| جیسا | ExtraBold | 2.289 | 2.289 | 2.289 |
| لگا | ExtraBold | 1.203 | 1.203 | 1.203 |
| جادو | Black | 2.255 | 2.255 | 2.255 |

Before: 14 of 32 words apart, up to 1.611 em (`کمائے`); every word apart has ہ ے ھ or ٹ. After: largest difference 4e-7 em.

### Fix

`packages/caption-fonts/src/shaping.ts`: `shapeCaptionRun(path, text, rtl?, context?: CaptionShapingContext)`, where
`CaptionShapingContext = { before: string; after: string }` is HarfBuzz pre/post context (up to 5 code points each side,
in the cache key); `layoutCaptionLine` passes the line's text around every run. Nothing in `bubble.ts` changed: the
template was right, the worker's measure was not. No Studio change: the Studio already matched libass.

### Which templates shared it

Hash of every Scene Style's scene (HarfBuzz) on the demo cues, fast cues (540x960), real English and Hindi cues
(`.scratch/motion-captions/out/review6-halftone/{en,hi}-cues.json`, 54 cues), the Urdu fixture and the same clip in
Arabic, plus every preset's whole ASS track (115 presets × English and Urdu fixture): **4 of 734 changed**, `scene ur
bubble`, `scene ur wonky`, `track ur bubble`, `track ur wonky`. Bubble and Wonky are the two templates set in Rubik.
Every Latin scene (demo, fast, real English), every Hindi and Arabic scene and every English track is byte-identical.

Both measurers on every Arabic-script text all 84 styles measure in Urdu and Arabic (4,805 distinct): after the fix, apart
by more than 1e-4 em only in Squash (ur 0.29 em, ar 0.08 em) and Tape (ar 0.142 em, ur 0.018 em). That is another, older
cause, left alone: in a multi-word piece whose requested face lacks the script, the worker keeps the spaces (and Tape's
bullets, with their letter spacing) in the fallback face, which libass draws, while the Studio's Canvas and DOM draw them
in the requested face (`ہم نے ایک` in Montserrat: Nastaliq spaces).

### Parity

Ticket 12's harness (Studio = prototype `?debug=1` in headless Chrome on port 3000; export = `renderCaptionTrack`):
bubble-rtl emoji rows 0.00 px in centre, size and tilt on all four (were up to 28.27, 3.50); every other frame still 0.00.
Bubble Urdu cue boxes: before up to 95.8 px apart (cue 1 x2 808.2 export vs 904 Studio), after 0.00 on all 10.

Arabic (the prototype has no Arabic frame, so the Studio's `canvasMeasure` is replayed from Chrome-measured Canvas values
plus catalog ascent/descent; the replay reproduces the real harness's 95.8 px on the old shaper): Bubble and Wonky
Arabic cue boxes 0.000 px apart before and after (Rubik draws every letter of the Arabic text, so no face change).
Wonky Urdu: 193.5 px before, 0.000 after.

### Frames (looked at)

`/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-fix-bubble/bubble-rtl-{0,1,2,3}-side-by-side.png`:
Studio | export (fixed) | export (before), full frames and the caption band at 1:1. The fixed export matches the Studio:
same bubble size and place, same word positions, same emoji. Before, `یہ ایک` had a wide gap and the starburst sat larger
and further right. Words join as before (Rubik letters joined to Nastaliq ہ and ے, e.g. `پیسے`, `یہ`).

### Tests

- `apps/media/src/caption-scene-urdu-parity.test.ts` (new) with `__fixtures__/scene-urdu-studio-canvas.json` (the Urdu and
  Arabic cues and 130 Chrome Canvas measurements): every text Bubble and Wonky measure has the same advance on both sides,
  and their Studio and export cue boxes are within 1 px, in Urdu and Arabic. On the old shaper (loaded through a Bun
  plugin, `old-shaping.ts`): 3 fail (Urdu table; Bubble 95.8 px; Wonky 193.5 px).
- `packages/caption-fonts/src/shaping.test.ts`: "a cursive word keeps its joining forms across a change of face": `کے`
  0.892, `یہ` 0.541, `بہت` 1.644 em (Rubik + Nastaliq parts); Latin split runs are the sum of their runs. Old shaper:
  fails (2.332).

### Verification

- `bunx biome check` on the four touched code paths (`shaping.ts`, `shaping.test.ts`, the new test and its fixture): clean.
  `bun run lint`: fails only in `.scratch/caption-templates-v2/` (gallery samples, not this ticket); no code file.
- `bun run typecheck`: 17 of 17 successful.
- `bun run --cwd packages/caption-fonts test`: 221 pass, 0 fail.
- `bun run --cwd packages/caption-scene test`: first run 3,225 pass, 1 fail (Barrel conformance, 5.87 s against the 5 s
  timeout while other suites ran; passes alone with either shaper, and caption-scene tests use the fake measure). Re-run:
  3,226 pass, 0 fail.
- `bun run --cwd apps/media test`: under three other builders' suites it timed out widely (5 s and 120 s limits), so it was
  re-run as `bun test --timeout 120000 src/ scripts/`: 1,236 pass, 1 skip, 1 fail (`worker process samples worker and
  command memory`, an RSS delta that came out negative under load; `worker-process.test.ts` alone: 78 pass). Files that
  had timed out, alone: 145 pass.
- Cost: 14 whole 60 s tracks (7 presets × English and Urdu, 20 emojis), median of 5 processes on a quiet machine: 1,369 ms
  with context against 1,349 ms without (+1.5%; the shaping cache key now holds 5 code points of context each side).
- No dev server started or stopped; Chrome read the owner's port-3000 prototype page only.
