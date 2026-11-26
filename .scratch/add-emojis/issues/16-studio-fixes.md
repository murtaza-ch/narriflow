# 16 - Studio fixes from the Opus and Sol reviews

**What to build:** The Studio-side defects two independent reviews found in the emoji controls and
the AI run. Rules: [../RULES.md](../RULES.md).

**Blocked by:** [09b](09b-controls-polish.md)

**Status:** done

## Areas

`apps/web/.../studio/_components/emoji/**` except the five files ticket 14 owns
(`caption-emoji-layer.tsx`, `cue-caption-emojis.tsx`, `scene-caption-emojis.tsx`,
`cue-emoji-boxes.ts`, `use-caption-emoji-art.ts`); the mount points in `transcript-panel.tsx` and
`studio-shell.tsx`; the prototype page. Each defect needs a test that fails before the fix.

## Defects

1. **The AI run reads and writes through the hook instance that started it** (Opus review).
   `use-caption-emojis.ts` (about lines 96-104) uses `latest.current`; when the Captions panel
   closes mid-run that instance unmounts and the ref goes stale, so an emoji added from a
   transcript chip during the run is overwritten when the answer arrives, and there is no clip
   guard. Keep the live source (entries, words, dispatchers, clip id) in the per-clip run state in
   `caption-emoji-runs.ts`, updated by every mounted editor for that clip. Merge the answer against
   that; drop it if the clip changed or nothing for that clip is mounted to dispatch. Tests with
   fake sources: panel closed mid-run, a hand edit, then the answer (hand edit survives); clip
   switched mid-run (answer dropped); two editors mounted (one dispatch).
2. **A stalled save lets a suggestion land on rewritten text** (Sol review).
   `studio-caption-emojis.tsx` (about line 57): the request goes out after the 6 s wait even when
   the checkpoint returned false, and nothing checks that the transcript is still the one that was
   tagged. Reproduction: a suggestion for `party` at 0.800 s survives when that word is replaced by
   `hospital` at the same timestamp. Require a successful checkpoint (if the save cannot finish,
   say so in the section with a retry; do not call the model). Take a fingerprint of what was
   tagged (kept words' keys and texts, cuts, censor masks) when the run starts and drop any pick
   whose word no longer has the same key and text when the answer arrives; if cuts or masks
   changed, re-filter against the current ones.
3. **Success is reported after the editor rejects the write** (Sol review).
   `caption-emoji-runs.ts` (about line 83) and the reducer's 500 cap (`editor-document.ts` about
   853): with 500 picks in flight and one hand-placed emoji added meanwhile, the 501-entry merge is
   rejected, only the hand-placed one remains, the run says "Added 500" and stores the rejected map
   as its baseline. Trim the merged result to the cap keeping hand edits first, then the strongest
   or earliest picks, derive the count and the baseline from what was actually committed, and say
   so when picks were left out. Also: Regenerate asks for confirmation whenever emojis exist and
   were not all produced by an AI run in this session (after a reload their provenance is unknown).
4. **Mixed-direction word chips reverse embedded phrases** (Sol review). `emoji-chips.tsx` (about
   line 104): for `مرحبا New York الآن` the chips show `York New`. Lay the chips out with the
   shared caption word order (`captionWordVisualOrder` in `packages/caption-fonts/src/bidi-order.ts`,
   the function the caption renderers use) and keep each chip's original edit target. Apply to the
   "On screen now" chips and anywhere else words are shown as chips.
5. **Every transcript row resolves all anchors** (Sol review). `transcript-panel.tsx` (about line
   1431) mounts a per-row editor and each one runs the full anchor resolver when entries change
   (measured: 1,000 rows of 15 words take 500 ms before React paints). Resolve once per document
   change at the panel level and give each row only its own targets through props or a selector,
   so an emoji edit re-renders only the rows it touches. Measure before and after with a
   1,000-row document.
6. **A failed art load is never retried** (Opus review): this one is ticket 14's file; skip it.

## Details

7. The Add with AI button turns bright white while running and is grey when idle. Keep one
   surface and show progress inside it.
8. The picker popover can hang past the bottom of the Captions panel and the window. Position it
   with collision handling (flip above its trigger, shift inside the viewport, cap its height to
   the space available and scroll inside), using the positioning the Studio's other popovers use.
9. A line chip jumps the playhead to its emoji (Sol review: "put the edit where the creator sees
   the problem"). Clicking a line chip seeks to the anchor word's time and opens the picker;
   find the Studio's existing seek function (the transcript rows already seek on click).
10. Move an emoji to another word of its line without deleting it (Sol review): in the picker
    opened from a chip, a small row of that line's words (in visual order) with the current anchor
    marked; choosing another word moves the emoji in one undo step. Words that cannot take an
    emoji (cut, censored, already holding one) are not offered.
11. A chip whose emoji is stored but does not draw (its word is cut or censored, or its cue has a
    typed emoji) looks the same as one that draws. Dim it and name the reason in its accessible
    label and title. Use the data the hook already has; do not run the composition plan in the
    panel.

## Acceptance

- [x] Items 1 to 5 and 7 to 11, each with its test, measurement or screenshot (light and dark, in
      `.../scratchpad/emoji-studio/controls-v3/`).
- [x] Web tests, `bun run typecheck`, `bun run check:web-split`, biome on touched files.

## Evidence

Implemented 2026-11-26. Nothing committed. Paths below are under `studio/_components/emoji/` unless noted.

### The AI run (items 1, 2, 3)

`caption-emoji-runs.ts` was rewritten as one explicit state machine kept outside React, one per clip:
`idle → saving → running → done { added, leftOut, partial } | failed { reason }`. The reasons are
`save | request(code) | read_only | incomplete | closed`. The transitions are a pure function
(`captionEmojiRunTransition`): a start while a run is busy is ignored, and so is a dismiss.
"Applying" is not a state. The answer is applied in one synchronous dispatch inside the `done` step,
so a separate state could never be seen.

- Item 1: every mounted editor registers a live source (`registerCaptionEmojiSource`: entries, word
  model, read-only, `replace`). The run reads and writes only through the latest source registered
  for its clip. It no longer goes through the hook instance that started it. With no source mounted
  for the clip, the answer is dropped and the run fails with `closed`.
- Item 2: the run requires a successful save. The Studio's `save` races `checkpointCloud()` against
  6 s and returns false on a timeout, and then the model is not called. When the save finishes, the
  run takes `captionEmojiFingerprint(model)` (Word Key → text of every word that shows). When the
  answer arrives, `planCaptionEmojiAnswer` keeps a pick only if its word still shows now and has the
  same key and text as in the fingerprint, so changed cuts and masks re-filter against the current
  ones.
- Item 3: the merge keeps hand edits first, then the earliest picks, and trims to
  `CAPTION_EMOJI_LIMIT`. The answer carries no strength, so "strongest" cannot be applied and
  "earliest" decides. `replaceEmojis` now returns the emojis the document holds after the write
  (Studio: read from `studioSession.getSnapshot()`). `countCommittedPicks` and the baseline come
  from that value. Regenerate asks for confirmation whenever emojis exist that differ from the last
  value an AI run committed in this session (`captionEmojisNeedConfirm`), which includes after a
  reload.
- `complete` (ticket 15): if it is false and the clip had emojis, the run fails with `incomplete`
  ("Couldn’t finish. Your emojis are unchanged."). If the clip had none, the run keeps what was
  tagged and reports `partial` ("Added N emojis. Part of this clip couldn’t be tagged."). A missing
  field counts as true. The Studio reads the field off the current response type without a cast,
  so it works before and after ticket 15.

Tests (`caption-emoji-runs.test.ts`, 19, all written first: red on the old module, then green):
- Fake sources:
  - panel closed mid-run, then a hand edit from a transcript chip: the hand edit survives;
  - clip switched mid-run: the answer is dropped (`closed`);
  - two editors mounted: one dispatch;
  - a save that cannot finish: suggest is never called;
  - a rewrite during the run: the pick on the rewritten word is dropped;
  - 500 picks plus one hand-placed emoji: 500 stored, `added 499, leftOut 1`, and no confirm against
    the committed baseline;
  - an incomplete Regenerate: nothing replaced;
  - write lease lost while waiting: nothing applied;
  - a typed failure code, and a second start ignored.
- Pure functions:
  - fingerprint excludes cut words;
  - party → hospital at 0.800 s: the pick is dropped;
  - a pick on a word cut since tagging is dropped;
  - hand edits win;
  - trim order;
  - incomplete vs partial;
  - a missing `complete` counts as complete;
  - `countCommittedPicks`;
  - the transitions table.
- `use-caption-emojis.test.tsx`: Regenerate confirm (after a reload, after an AI run, after a hand
  edit and undo), and move in one undo step.

### Item 4: mixed-direction chips

`emoji-chip-order.ts` (`chipVisualOrder`) lays chips out with `captionWordVisualOrder`, the same
function the caption renderers use. It covers On screen now chips, line chips (when a line holds
two or more) and the picker's move row. Chips sit in a left-to-right container; RTL cues align to
the right. Each chip keeps its own edit target.

Tests (`caption-emoji-words.test.ts`):
- `مرحبا New York الآن` with an RTL base → `[3, 1, 2, 0]`, so the screen reads "الآن New York مرحبا";
- a live cue with those words comes out left to right;
- Urdu cues come out reversed, with the first word rightmost.

Screenshots: `mixed-script-*.png`, `mixed-script-picker-*.png`, `rtl-picker-move-*.png`.

### Item 5: transcript rows

`caption-emoji-lines.ts` holds the fix. `StudioCaptionEmojiLines` is mounted once around the
transcript rows (`transcript-panel.tsx`, the only change there). It runs one editor, which resolves
anchors once per document change, and publishes to a small store. Each row selects only its own
lines' view (`useCaptionEmojiLine`), and that view keeps its identity while unchanged. Rows no
longer subscribe to `studioEdits`, `captionLayers` or the editor. The picker host's
`useEmojiPickerOpenFor(element)` means opening or closing the picker re-renders only the affected
chip, no longer every row.

Measured in Bun on a 1,000-line × 15-word document with 200 emojis, 5 edits each:
- Before (every row runs `placeCaptionEmojis`, `lineEmojiTargets` and `lineAddWord`): 376, 332, 330,
  333, 329 ms of compute per edit, before React re-renders all 1,000 rows.
- After (placement once, then every row's selector): 3.6, 5.0, 3.2, 2.8, 2.3 ms. Exactly one row
  gets a new view per edit (`caption-emoji-lines.test.ts`, which asserts it).

### Item 7: one surface

Add with AI and Regenerate are now one `RunButton` with the panel's `PanelButton` surface
(`studio.raised`) in every state. While a run is out, the spinner and "Adding emojis…" show inside
it, with no change of opacity or colour. The hint below reads "Saving your edits first." while
saving.

Test: `emojis-section.test.tsx` checks that the background and opacity read from the emitted CSS
are the same idle and running, and equal `studio.raised`.

Screenshots: `none-*.png`, `running-*.png`.

### Item 8: picker position

`emoji-picker-host.tsx` sets positioning `{ flip, slide, fitViewport }`. The content is capped at
`var(--available-height)`, and the grid is the flex item that shrinks (2-row minimum) and scrolls.
`reveal` uses the grid's real height.

Checked over CDP in real time (headless virtual time catches the enter fade) at 880×640, from the
last line's chip: `placement: top-start, height 321 = --available-height 321px, opacity 1`.

Screenshots: `picker-bottom-*.png`. A reusable CDP screenshot script is in this session's scratchpad
(`cdp-shot.ts`).

### Item 9: a line chip seeks

`openLineEmojiChip` moves the playhead to the anchor word (`seekTo(baseEditedToComposite(sec))`),
then opens the picker.

Test: `emoji-chips.test.tsx`. The prototype shot `picker-move-*.png` shows the playhead jumped to
1.08 s with IDEA live.

### Item 10: move to another word (about 60 lines)

`emojiMoveChoices` (words.ts) and the picker's `request.move` row offer the anchor's line in visual
order. The current word is marked with accent and `aria-pressed`. Cut, censored and occupied words
are left out. Choosing a word calls `editor.move`, which issues one `setCaptionEmojis({ old: null,
new: ref })` (one undo step).

Tests: the words test (LTR with a cut and an occupied word; RTL), the chips test (the picker request
and `onMove` dispatch), and the hook test (one undo step).

### Item 11: dimmed chips

`captionEmojiHiddenReason` returns `cut`, `censored` or `typed-emoji`. The typed-emoji check reads
cue ranges from the Studio's existing `captionLayers`, using the plan's rule, with a pictographic
regex prefilter (`typedEmojiCueRanges`). The composition plan is not run. Line chips and live chips
with an emoji are dimmed to 0.5, and the reason appears in the title and the accessible label.

Tests: the words test (all three reasons) and the chips test (the label and title on a cut word).

Screenshot: `hidden-*.png` (cut "idea"; "team" in a cue with a typed 🔥, on its line and live).

### Prototype

`?suggest=partial|unsaved`, `?state=hidden`, `?script=mixed`, `?open=last`; `run=1` now answers
Replace when Regenerate asks.

Screenshots in `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-studio/controls-v3/`, each as `-dark` and `-light`: none, running, added, partial, unsaved,
incomplete, hidden, mixed-script, picker-move, picker-bottom, rtl-picker-move, plus
`mixed-script-picker-*`.

### Files outside the emoji folder

- `studio-shell.tsx`: `replaceCaptionEmojis` returns the emojis the document holds afterwards
  (+2 lines).
- `transcript-panel.tsx`: the `StudioCaptionEmojiLines` wrapper and its import.
- `caption-emoji-fixture.ts` gains `emojiFixtureManyLines`.

### Commands

- `bun run --cwd apps/web test`: 1,343 pass, 0 fail.
- `bun run typecheck`: 17 of 17 successful. An earlier run failed in
  `packages/composition-plan/src/zz-plan-hash.ts` and `app/prototype/caption-emojis`, other
  tickets' files mid-edit; both cleared on re-run.
- `bun run check:web-split`: passed.
- `bunx biome check` on the emoji folder, `transcript-panel.tsx`, `studio-shell.tsx` and the
  prototype folder: clean (34 files).
