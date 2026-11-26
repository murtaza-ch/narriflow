# 24 - An emoji on a cue's last word leaves cleanly

**What to build:** When an emoji's word is the last of its cue, the emoji holds 400 ms so it can
be read, which carries it up to a quarter-second into the next caption (ticket 21, part C). The
owner's instruction: do it the best possible way for the viewer. Rules: [../RULES.md](../RULES.md).

**Blocked by:** [23](23-whole-catalog-functional.md) (same file, `packages/caption-scene/src/emoji/layer.ts`)

**Status:** done

## Decision (coordinator)

Keep the hold: an emoji shown for under a quarter-second is a flicker, and dropping it loses a
relevant pick. Make the carried-over part read as the previous caption's emoji leaving, never as
part of the next caption:

1. **It yields to the next caption's own emoji.** A held emoji ends, at the latest, when any emoji
   of a following cue starts, so two emojis are never on screen together. Check the rule across
   cues, not only within one cue, on all three caption paths.
2. **It leaves visibly.** From the moment its own cue ends, the held emoji is on its way out: it
   fades and shrinks slightly (to about 0.85) over the remaining hold instead of sitting at full
   strength and then cutting. The whole visible time stays at least 400 ms from its word; at least
   the first 250 ms are at full strength. One pose function in `packages/caption-scene/src/emoji/`
   for both renderers; check the ASS writer still emits one event per piece (the exit is a `\t`
   chain, not per-frame events) and state the event count.
3. **It never covers the next caption.** The existing collision check already keeps it off the next
   cue's text; add a test that a held emoji's box does not meet any word of the next cue at any
   sampled time, on a classic, a Dynamic and three Scene presets, LTR and RTL.
4. **It does not jump.** The held emoji stays where it was placed for its own cue; it is not
   re-placed against the next cue's block.

## Deliverables

- The rule above in the shared layer, with tests for 1 to 4 and for the unchanged cases (250 ms or
  more of the cue left: no change; under 120 ms: still not drawn).
- The Studio's held-cue feeder (`studio/_components/emoji/held-cue-*.ts(x)`) and the worker give
  the same result: extend ticket 21's feeder test.
- Measure on the four real clips: how many emojis are held, how long each overlaps the next
  caption, before and after.
- Render the real clips' held cases as short frame strips (every frame from the emoji's word to
  its last frame, about 12 to 15 frames each, three cases, on Electric, Headline and Reveal) into
  `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-late-hold/`
  and look at them as a viewer would: does the emoji read as leaving with its caption?

## Acceptance

- [x] The deliverables above; measurements and strip paths in Evidence.
- [x] `bun run typecheck`; tests of `packages/caption-scene`, `apps/media`, `apps/web`; biome on
      touched files. No dev server started.

## Evidence

Done 2026-11-26. Nothing committed, migrated or deployed; no dev server or browser used. Scratch root `M = /private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/8c9f4818-55bd-4507-846c-32fca366e571/scratchpad/m`;
strips in `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-late-hold/`.

### Measurement setup

`M/held.test.ts` (run from `apps/media`): 16 real documents (ticket 21's 12 tagged runs, 3 × 4 clips at Balanced, plus
ticket 21's four final AI picks), the project's caption language (en, hi, en, ur), Electric 3, Headline 3/4/5, Reveal
3/4/5, Tunnel 3/4/5, Horizon 3/4/5 words per cue; export path `planClipComposition` (9:16) → `compileCompositionPlanCaptions`
at 30 fps, placement read from the shared `placeCaptionEmojis`. Next-cue boxes come from the same plan with an emoji on
every cue (boxes do not depend on emojis).

### Before (ticket 21's rule, measured on the tree before any edit, `M/before.txt`)

Over 16 documents × 13 preset/words-per-cue runs: 740 emojis placed, **40 held** past their cue (5.4%), each on screen
**100 to 260 ms into the next caption (mean 169 ms)**, of which a mean 79 ms (max 170) at full strength before its 90 ms
fade. Two emojis on screen together: 0 (no next-cue emoji starts within any hold on these clips). **A held emoji covered
the next cue's text 4 times on classic and Dynamic presets**: the Urdu clip's 📱 on "iPhone" (Electric 3, Headline 3/4/5):
a Latin cue followed by an Urdu one, whose Nastaliq line box (y 958 to 1541) is four times the Latin box (1308 to 1456), so
the 📱 above its own line sat inside the next caption. Ticket 21 had measured 0 because its run planned without the caption
language. Scene Styles: 0 under the precise check below (`M/before.txt` flags Reveal and Tunnel against rest boxes; the
Scene obstacles already see other cues' live text, and the precise check of the same windows finds nothing).

### The rule as built (`packages/caption-scene/src/emoji/{layer,timing,style,cue-box}.ts`, one function for both renderers)

1. **Yield.** A held emoji (its word leaves under `CAPTION_EMOJI_MIN_HOLD_MS` = 250 ms of its cue) ends at
   `min(word + 400, the first emoji of a later cue)`, never before its cue's last paint. The later emoji counts by its
   word's plan time whether or not it draws, because a one-cue feeder cannot know more: on a Scene Style the layer reads
   it from its own input; a classic or Dynamic feeder passes `nextEmojiAtMs` (`CaptionEmojiLayerInput.nextEmojiAtMs`,
   from the shared `captionEmojiNextAtMs(layers, cueIndex)`). If the yield leaves it under 250 ms from its word, it draws
   nothing (`no-time`): a sub-quarter-second sticker replaced by the next one is the flicker the hold exists to avoid.
2. **Leaving pose.** `captionEmojiScale`/`captionEmojiOpacity` (timing.ts) take a `leaveFromMs`; the layer passes
   `max(cue's last paint, shown start + 250)` for a held window. From there the emoji fades linearly to 0 and shrinks
   linearly to `CAPTION_EMOJI_LEAVE_SCALE` = 0.85 by its window's end; the exit is never shorter than the usual 90 ms
   fade and never starts inside the entrance. Since every held word leaves its cue under 250 ms, the exit always starts
   250 ms after the word: full strength for 250 ms, then 150 ms leaving (a 400 ms hold). An emoji that ends with its cue
   keeps its entrance and 90 ms fade unchanged.
3. **Off the next caption.** A cue box without `obstacles` (classic line, Caption Block) is missed itself and so is every
   other cue box of the input while that cue paints (`withOtherCues`). The classic and Dynamic feeders pass the next
   cue's box beside their own: a Dynamic block's own box (both renderers lay it out), and for a classic line its reach,
   `classicLineReachBox(cue, heightEm, canvas)`: the line box at the preset's size, as wide as the fit allows, because
   the Studio lays out only the line on screen. A held emoji whose slot meets the next box takes another side or size
   (placement checks its whole window), else it draws nothing. Scene Styles already had this through their obstacles.
4. **No jump.** Placement checks the whole window up front, so the emoji keeps the one slot for its whole life; the
   Studio's held mount draws from the exact input the on-screen cue was placed from (`rememberHeldCue`), and the Studio's
   layer reuses a build with an equal key (`buildCaptionEmojiLayerOnce`, a 32-entry cache by layer key) so the held mount
   paints in its first render instead of waiting a deferred render (a blank frame at the cue change before).

### After (`M/after.txt`, precise check: classic and Dynamic against the next cue's exact box, Scene Styles against later cues' text pieces at opacity 0.1 or more)

| | before | after |
| --- | --- | --- |
| placed / held | 740 / 40 | 738 / 38 |
| time into the next caption | mean 169, max 260 ms | mean 170, max 260 ms |
| of it at full strength | mean 79, max 170 ms | mean 27, max 110 ms (then fading and shrinking) |
| two emojis on screen together | 0 | 0 |
| held emoji covering the next cue's text | 4 (classic and Dynamic), 0 Scene | **0** |

The two emojis lost are the 📱 on Electric 3 and Headline 3 (no clear side at either size); on Headline 4 and 5 it moves
below its line. Cost of the classic reach box: Electric, Bold Pop and Karaoke at 3, 4 and 5 words per cue on the same 16
documents (`M/classic.test.ts`): 27 held after against 27 + the 📱 with the own box alone; no other held emoji lost.
Yield never triggers on these clips (no later-cue emoji within 400 ms of a held word); the tests cover it.

### Events (`M/events.test.ts`, real Scene writer, a held emoji at 150 ms before its cue's end)

One event per piece before and after at 24, 30 and 60 fps: rocket 6 → 6, heart-eyes 7 → 7, sun 5 → 5, mobile-phone 5 → 5,
astronaut 20 → 20. The exit adds `\t` spans, not events: at 30 fps 8 → 9 per piece, at 24 fps 6 → 10, at 60 fps 12 → 13.

### Frame strips (`H = /private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-late-hold`)

Production render path (`bun apps/media/scripts/caption-scene-real-render.ts`, each preset at its own words per cue as
the Studio applies it: Electric 3, Headline 4, Reveal 4; all outputs `validateRenderOutput` ok), then every frame from one
frame before the emoji's word to one after its last (29.97 fps, 12 to 15 frames), labelled with clip ms
(`M/../tools/strips.py`; `SIDE=420` gives close-ups around the emoji). Only the Urdu clip's source is still on disk;
hi-matte is a second clip of the same source file (19,051,263 bytes), so both render. Before = ticket 21's renders of the
same documents (`.../emoji-relevance/final-21/*/out`).

| Case | Strip | Read as a viewer |
| --- | --- | --- |
| Electric, 😵‍💫 on "WEIRD" (hi-matte run 1, 19.15 → 19.55 s) | `H/strip-electric-dizzy-after.png` | Pops on "WEIRD", full while its line shows, already fading in the 100 ms gap after the line; faint and smaller when "ORIENTATIONS और BLACK" arrives, gone a frame later. Reads as leaving with its line. |
| Headline, ☀️ on "glare" (hi-matte, 2.83 → 3.23 s) | `H/strip-headline-sun-{before,after}.png`, close-ups `H/pair-headline-sun.png` (top before, bottom after) | Before: full strength when "बहुत" comes in, fades after it. After: dimmer and smaller as "बहुत" comes in, half gone a frame later, faint the next. It reads as the previous caption's sun leaving, not as the sun of "बहुत". The shrink is subtle; the earlier fade carries most of it. |
| Reveal, 📱 on "iPhone" (Urdu, 33.36 → 33.67 s) | `H/pair-reveal-phone.png`, `H/strip-reveal-phone-{before,after}.png` | Identical before and after: Reveal's next cue sweeps in from the right, so placement already trims the window to 307 ms and the exit is the 90 ms fade. About one full frame beside the incoming line, then gone, never over it. |
| Headline, 📱 on "iPhone" (Urdu, the case that covered) | `H/pair-headline-phone-samecrop.png` (top before, bottom after, same crop) | Before: above "screen", and the next caption "کے لیے" lands against it (33.70 to 33.73 s). After: placed below "screen" for its whole life, nowhere near "کے لیے", leaving by 33.73 s. Fixed. |
| Electric, 📱 on "iPhone" (Urdu) | `H/strip-electric-phone-before.png`, `-after.png` | Before: sits right above "کے لیے OPTIMIZED نہیں" for five frames, reading as that caption's emoji (its ink misses the letters but is inside the Nastaliq line box). After: not drawn (`no-room`: covered above and below by the next line box, at both sizes). A lost pick, by the classic line-box rule both renderers share. |

Judgement: the carried-over part now reads as the previous caption's emoji on its way out wherever the hold is long
enough to show it (the ☀️ and 😵‍💫); where a Scene Style's own exit already trims the window, nothing changes and nothing
needs to. The visible change per case is one or two frames of strength; the larger fix is the 📱 that used to sit
against the next caption.

### Tests

- caption-scene `layer.test.ts` "a held emoji leaves with its caption": the pose (full strength from the entrance to
  word + 250, then opacity and scale strictly falling to 0 and 0.85 by word + 400, one position throughout); unchanged
  cases (250 ms or more left: window to the cue's end, the 90 ms fade, the entrance-only scale, even with a next box and a
  next emoji; under 120 ms: `no-time`); the yield (one input with both cues equals a one-cue input with `nextEmojiAtMs`,
  the next emoji starts where the held one ends, the 90 ms fade floor, `no-time` under 250 ms, the layer key); the next
  box (a taller next cue moves the held emoji below and its ink never meets the box; covered on both sides: `no-room`;
  an emoji that ends with its cue keeps the slot above). Each fails on ticket 21's code.
- media `caption-emoji-ass.test.ts` "a late word's emoji holds past its cue and leaves, the same on both feeders"
  (ticket 21's feeder test, extended): Electric, Headline and Reveal, with and without a next-cue emoji: the export writes
  one event per piece from the word to the hold or the next emoji, with `\1a` and scale `\t` exit spans; the Studio's
  inputs (`emojiFollowingCue`, the classic reach box from the web's `classicLineBoxEm`, which matches the worker's to the
  pixel) place identically to the worker's; the held mount returns the exact input on every export frame after the cue.
  "a held emoji never covers the next cue's words": Electric, Headline, Reveal, Tunnel and Horizon × LTR, RTL and an
  English cue before Urdu ones, every export frame from the cue's end, against the next cue's exact box (classic,
  Dynamic) or its text pieces at opacity 0.1 or more (Scene): 8 of 15 hold, none covers; 2 would have covered with the
  own box alone (the test asserts both counts are non-zero).
- web `held-cue-boxes.test.ts`: the remembered input, and `emojiFollowingCue` (the next cue, the first later emoji, none
  for a cue without emojis).

### Files

- `packages/caption-scene/src/emoji/timing.ts`: `CAPTION_EMOJI_LEAVE_SCALE`; `captionEmojiScale`/`captionEmojiOpacity` take `leaveFromMs`.
- `packages/caption-scene/src/emoji/layer.ts`: `nextEmojiAtMs`, the yield and its `no-time`, `withOtherCues`, `leaveFromMs`, key.
- `packages/caption-scene/src/emoji/style.ts`: `captionEmojiNextAtMs`. `cue-box.ts`: `classicLineReachBox`. `layer.test.ts`: tests.
- `apps/media/src/caption-ass.ts`: `reachBoxes` on the collector, `oneCueEmojiGroup` (own box + next cue's), target layers to the emoji layer.
- `apps/media/src/caption-emoji-ass.ts`: `captionEmojiEvents({ layers })` passes `nextEmojiAtMs` per group. `caption-emoji-ass.test.ts`: tests.
- web `studio/_components/emoji/held-cue-boxes.ts`: `OneCueEmojiInput`, `EmojiFollowingCue`, `emojiFollowingCue`, `rememberHeldCue` (replaces `rememberHeldCueBox`); test.
- web `emoji/cue-caption-emojis.tsx`: classic and block feeders build [own, next] and pass `nextEmojiAtMs`; the block's next box from `useCaptionBlockPaint`.
- web `emoji/held-cue-emojis.tsx`: draws from the remembered input. `emoji/caption-emoji-layer.tsx`: `nextEmojiAtMs` prop; builds cached by layer key.
- Outside the listed files (one prop each): `interactive-caption-overlay.tsx` (`emojiFollowing`), `video-preview.tsx` (computes it).
- Spec section 7: the as-built paragraph for 24.

### Deviations

- **The covering was real** (coordinator's premise: "the existing collision check already keeps it off"). Per-cue
  placement never saw the next cue; the fix needs the next cue's box in both feeders, so the classic and Dynamic feeders
  gained it. For a classic line the box is its reach (full size, fit width): the Studio has no layout of a line before it
  shows. That over-states a long fitted next line; on the real clips at 3, 4 and 5 words per cue on three classic presets
  it cost nothing beyond the covering 📱.
- **Exit start.** "Fades from the moment its own cue ends" and "at least the first 250 ms at full strength" conflict for
  every held emoji (its word leaves under 250 ms); the 250 ms wins, so the exit runs from word + 250 to word + 400. The
  exit is never shorter than the 90 ms fade, which can take a little from the 250 ms when the window was cut (a yield, or
  a Scene trim as on Reveal).
- **A yield that leaves under 250 ms draws nothing** (not stated in the ticket): such a sticker replaced at once by the
  next is the flicker the hold exists to avoid.
- **Studio build cache** (`caption-emoji-layer.tsx`): not asked for, part of "does not jump": the held mount used to wait
  one deferred render before painting, a likely blank frame at every cue change with a held emoji. Not verified in a
  browser (no dev server or browser per the brief).
- Studio limit: the next Caption Block's box comes from its painter's layout once its faces load; until then the cue's
  emojis are placed without it and may re-place when it arrives (the same faces as the cue on screen, so normally loaded).

### Verification (final tree)

- `bun run typecheck`: 17/17 (an earlier run failed only in `app-chrome.tsx`/`workspace-query-gate.tsx`, another
  agent's edit in progress; clean on re-run).
- `bun test` in `packages/caption-scene`: 3,221 pass. `bun run --cwd apps/media test`: 1,230 pass, 1 skip, 0 fail (the
  `worker-process.test.ts` memory test did not fail this run). `bun run --cwd apps/web test`: 1,463 pass, 0 fail (an
  earlier run had Workspace-gate failures from the same other edit; gone on re-run).
- `bunx biome check` on the 15 touched code files: clean.
