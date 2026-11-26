# 22 - The Studio's subtitle panel, one row per caption (like Vizard)

**What to build:** The owner compared the Studio's transcript panel with Vizard's "Edit subtitles"
panel and asked for ours to work and read like it: short rows, one per caption as it appears on
the video, each with its time range and an emoji button at the right edge; a paragraph view with
times in a left column; no speaker labels. Rules: [../RULES.md](../RULES.md).

**Blocked by:** [21](21-emoji-on-its-word.md) (shares Studio emoji files)

**Status:** done

## The owner's references (look at them first)

- Vizard, Sentence view: `/Users/murtaza/.t3/userdata/attachments/c6bf7fda-c97e-4ad5-a81a-35b14c64dc87-1a539a2b-7a70-4df1-a210-4f42704a9283.png`
- Narriflow today: `...-7d919445-4398-4c2d-9d48-9a0afae55797.png` and `...-ed042152-a748-4287-9ea9-54d556ac5828.png` (same folder and prefix)
- Vizard, Transcript tab: `...-e2fd0ab5-ccc8-4793-b133-d02e89f7e5e2.png`
- Vizard, Paragraph view: `...-09e8203e-8759-4b8d-8500-246731854594.png`
- Earlier Vizard shots of the emoji button with an emoji in it and the delete beside it on hover:
  `...-61b3ccb0-0cde-45a3-ba83-ee1eecef8432.png`, `...-507f49b5-8333-46c6-aba6-be55c06a6ca8.png`

His decisions (asked and answered 2026-11-26): **hide speaker labels**; **one row per on-screen
caption**. His words: "Please make it good. like the vizard ai."

## Today (from a read-only map of the code)

`S/` = `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/`.

- `S/transcript-panel.tsx` (1,538 lines) has three views over `transcriptSlice` utterances: Word
  (inline words, selection toolbar, cut and restore), Sentence (`SubtitleLineEditor`, one row per
  utterance, which can be 30 s and 80 words), Paragraph (`SubtitleParagraphEditor`, runs of one
  speaker). `S/subtitle-lines.ts` holds the line operations.
- The on-screen captions are cues derived in the plan: `captionLayersForTarget` in
  `packages/composition-plan/src/clip-composition-plan.ts` groups each utterance's visible words
  with `groupCaptionTokens` (`packages/validators/src/caption-cues.ts`) by the preset's
  `wordsPerCue`; grouping never crosses an utterance. The panel does not read cues.
- A sentence edit (`replaceSubtitleLineText`) re-times every word of the utterance evenly, which
  changes Word Keys. There is no split operation. Sentence and Paragraph rows have no playhead
  highlight, no auto-scroll; only Word view has them. No search. No virtualisation.
- Speaker labels: Word and Sentence show one when the speaker changes; Paragraph always. Nothing
  in the panel renames a speaker. The "Transcript only" checkbox sets state nothing reads.
- The panel ignores the write lease: a reader can type and nothing is saved.
- Emoji chips mount in the row header through `StudioLineEmojiChips({ lines, text })`, addressed by
  utterance index (`S/emoji/{emoji-chips.tsx,studio-caption-emojis.tsx,caption-emoji-lines.ts}`).

## Deliverables

1. **Caption lines from the document, shared with the plan.** A pure function in
   `packages/composition-plan` that returns, for the source-language caption target, one entry per
   on-screen caption: the utterance it belongs to, its word range in that utterance, its text as
   shown, and its start and end in edited time, produced by the same grouping the plan uses
   (refactor so `captionLayersForTarget` and this function share the grouping code; do not copy
   it). It must not depend on the preview having reported `captionLayers`. When the preset's
   `wordsPerCue` or style changes the lines regroup, as the video does. Test: its lines equal the
   plan's cue texts and windows for every preset kind, with cuts, censored words and an inserted
   scene.
2. **Sentence view = one row per caption.** Each row: the time range on top in `mm:ss.cc - mm:ss.cc`
   (edited time, as on the video), the caption's text below in an auto-height field, and at the
   right edge an emoji button that is always visible (see 5). Rows are short; a clip's captions
   read top to bottom as they will appear.
   - Editing a row changes only that caption's words: same number of words means per-word text
     changes (times and Word Keys untouched); a different number re-times only that caption's
     span evenly between its first word's start and last word's end; every other word of the
     utterance keeps its time and key. One undo step per commit. Emojis, emphasis overrides and
     censor marks on untouched words must survive (test each). An emptied row deletes those caption
     words (footage is not cut), as "Delete subtitle line only" does today.
   - Row actions on hover or focus, at the right beside the emoji button: delete this caption's
     text, add a caption after this one (a new placeholder line; split the utterance at the row's
     boundary if the row is not its last caption, keeping every word's time). Decide what to do
     with "merge with next" (captions regroup on their own; if nothing needs it, remove the action
     and the unused operation) and say what you chose.
   - Clicking a row's time or its empty area seeks to the caption's start; focusing its text seeks
     too, as today.
3. **Paragraph view like Vizard.** The start time (`mm:ss`) in a left column, the paragraph's text
   beside it. Paragraphs break at a speaker change and at a pause long enough to read as a new
   thought (choose the threshold and a maximum length from the real clips under
   `.scratch/motion-captions/out/real/*/document.json`; a single-speaker clip must not become one
   giant paragraph). Editing keeps today's rule (text is redistributed over the paragraph's lines).
4. **The playhead in every view.** The row (Sentence) or paragraph under the playhead is
   highlighted with the Studio's selected-row surface (as in Vizard's Paragraph view), and the list
   scrolls it into view when it changes, unless the owner scrolled in the last 3 s or is typing in
   a row. State changes only when the active row changes, never per frame; find the active row by
   binary search. Word view keeps its word highlight; fix its per-utterance `indexOf` scan.
5. **The emoji button on each row** (extends `S/emoji/`): a square button at the row's right edge.
   With no emoji on the caption and emojis on: the add icon, always visible. With an emoji: the
   emoji's art in the button; hovering or focusing shows a remove control beside it, as in the
   owner's Vizard reference; pressing the button opens the picker (replace, move to another word of
   this caption, remove). Two emojis on one caption show two buttons. With emojis off: the add icon
   on hover only (adding turns emojis on, as today). The line store must address a word range of an
   utterance, not only whole utterances, and still re-render only the rows an edit touches.
   Paragraph rows keep chips with the anchor word named (a paragraph has many captions).
6. **No speaker labels** in any view of this panel. Speaker data stays in the document and keeps
   driving layouts and caption styles.
7. **Search.** A field at the top (Narriflow's borderless soft field): typing filters the Sentence
   and Paragraph rows to those containing the text and marks the matches; Enter moves to the next
   match and seeks to it; Escape clears. Case-insensitive, works for Urdu, Arabic and Hindi text.
8. **Header.** Keep the Word / Sentence / Paragraph switch and Auto-censor; show the language
   quietly. Remove the "Transcript only" checkbox and its state if nothing reads it (confirm by
   grep; the owner's rule is no dead controls). Decide the default view: Sentence is the view the
   owner is redesigning and matches the video; make it the default unless Word view is needed first
   for a reason you can name.
9. **Read-only.** When someone else holds the write lease (`editingElsewhere`), rows are not
   editable and actions are hidden, with the existing notice; today a reader types into a field
   that silently saves nothing.
10. **Right-to-left and mixed text.** Rows set `lang` and `dir` as today; the emoji button stays at
    the row's inline end in LTR and the same visual side in RTL (decide and be consistent with
    Vizard's fixed right edge); times stay LTR.
11. **Organisation and performance** (spec section 4). `transcript-panel.tsx` is already 1,538
    lines: split it by view into files in a `transcript/` folder (panel shell and header, word
    view, caption rows, paragraph rows, search, playhead hook), each focused. Rows are memoised;
    an edit re-renders the rows it touches; long clips stay smooth (measure the Sentence view on a
    180 s clip: mount time, edit-to-paint, and scroll, and use `content-visibility` or windowing if
    needed). No per-frame React state.
12. **Tests.** The caption-line function (1); the row edit operations in `subtitle-lines.ts` (same
    count, different count, emptied, add after with a split, RTL and no-space scripts as the
    existing tests cover); emojis and emphasis surviving a row edit; the active-row search; the
    search filter; static-markup tests for a caption row in each state (no emoji, one, two,
    emojis off, read-only, active, RTL). Keep `subtitle-lines.test.ts` green or update it where
    behaviour changes on purpose, and say which.
13. **See it.** A prototype page (beside the existing ones in `apps/web/app/prototype/`) that mounts
    the panel with a fixture document and a fake clock, with URL options for view, state, RTL and
    read-only. Do not start a dev server. If the owner's own dev server is answering on
    `http://localhost:3000`, you may load your prototype page from it read-only (never stop or
    restart it) and take screenshots with headless Chrome directly; if it is not running, rely on
    the tests and say so. Save screenshots of every view and state, beside the owner's Vizard
    references, to
    `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/subtitle-panel/`
    and compare them yourself: row height and rhythm, the time's weight against the text, the
    emoji button's alignment down the right edge, the active row. It should feel as calm and
    scannable as Vizard's, in Narriflow's own look (graphite Studio, no borders, soft fills).

## Acceptance

- [x] Deliverables 1 to 13; measurements and screenshot paths in Evidence; a list of every
      behaviour that changed on purpose (for example merge removed, default view).
- [x] `bun run typecheck`, `bun run test`, `bun run check:web-split`, biome on touched files.

## Evidence

Done 2026-11-26. A previous agent was cut off by a usage limit after building most of the
code without Evidence; this agent took stock, finished it and records each deliverable as proven.
Nothing committed, migrated or deployed. Screenshots:
`SHOTS = /private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/subtitle-panel/`.

Inherited state: `bun run typecheck` 17/17; composition-plan 320 pass; apps/web 1,403 pass, 3 fail
(`transcript/caption-rows.test.tsx`: two assertions matched the Emotion CSS that the row's selectors
emit, and one anchored on the first tag, which is a `<style>`; the markup itself was right).
Old `S/transcript-panel.tsx` deleted; the shell mounts `S/transcript/transcript-panel.tsx`.

**Change of instruction (owner, mid-ticket): "don't remove the merge lines option".** Deliverable 2's
"decide what to do with merge" is overridden: "Merge with next" stays as a Sentence row action
(Combine icon, beside add and delete, disabled on the last row) and must visibly hold now that a row
is one on-screen caption. Built: a stored `studioEdits.captionMerges` (first word's Word Key → last
word's Word Key) that the plan's one grouping function honours (see deliverable 2 below). Progress
notes, updated as work lands:

- Tests fixed (strip `<style>` before matching); Word view's follow-the-playhead scroll restored
  (the split had dropped it) through the shared `useFollowActiveRow`.
- Paragraph thresholds checked on the four real clips (`.scratch/motion-captions/out/real/*`):
  gaps p75 are 0.02 / 0.24 / 0.42 / 0.46 s and p90 0.02 / 0.42 / 0.76 / 0.86 s, so 0.7 s is above
  every clip's p75 and near the multi-speaker p90 (a real pause, not breath). 50 words is Vizard's
  paragraph length. The single-speaker 75 s Urdu clip gives 8 paragraphs (36, 19, 50, 24, 47, 50,
  44, 24 words), not one.
- Merge built (2026-11-26): `studioEdits.captionMerges` (validators `studio-edits.ts`, limit 2,000,
  included in `studioEditsEqual`); `groupCaptionCues` reads it through `mergedCaptionRanges` +
  `groupCaptionTokensWithMerges` (composition-plan), the one grouping the video, the subtitle files
  and the panel rows share. Web: `mergeCaptionRowWithNext` / `mergeSubtitleLineWithNext` /
  `followMergedRow` (`subtitle-lines.ts`), `captionRowCommandActions` + `mergeCrossesSceneSplit`
  (new `subtitle-row-commands.ts`, used by the shell and the prototype alike), row action in
  `transcript/caption-rows.tsx`. Neighbour stability sweep (merge every row with its next, 180 s
  fixture): Bold Pop 152 of 155 merges change no other caption, Headline and Reveal 123 of 126, Urdu
  17 of 17; the 3 that do are merges across two utterances, where the joined utterance's following
  captions regroup (the merged caption itself always holds, and video and list always agree).

### Per deliverable

1. **Caption lines, shared with the plan.** `deriveCaptionLines(document, { language })` in
   `clip-composition-plan.ts`; `captionLayersForTarget` and it both call `groupCaptionCues` (one
   grouping, then `boundCaptionCues`; scene splits through the same `captionCueSlice`). Independent of
   the preview's `captionLayers`; regroups with `wordsPerCue` and style. Test
   `caption-lines.test.ts`: lines equal `deriveCaptionCues` texts and windows and the planned layers
   for all 115 presets, with a cut word, a censored word and an inserted scene; plus merges (below).
2. **Sentence = one row per caption.** `transcript/caption-rows.tsx`: `mm:ss.cc – mm:ss.cc` on top
   (edited time), auto-height text below, emoji button at the right edge. Edits through
   `replaceCaptionRowText` (same count: text in place, times and keys kept; different count: only
   the row's span re-timed; emptied: words deleted, footage kept), one undo step per commit
   (`captionRowCommandActions` under one coalesce key). Hover/focus actions: Add caption after (splits
   the utterance at the row's end when needed), **Merge with next** (kept on the owner's instruction,
   Combine icon, disabled on the last row and between a timed and an untimed caption; refused with the
   old toast across a manual scene split), Delete caption. Clicking the time or empty space seeks;
   focusing the text seeks. A row keeps its draft while focused and rows are keyed by a stable id
   (first word's Word Key), so nothing remounts while typing.
   *Merge design:* captions regroup from words, so a merge is stored: `studioEdits.captionMerges`
   (first Word Key → last Word Key). The plan's grouping keeps those words in one cue; the grouping's
   own breaks before the range stand, and after it too when the range ends on one of them (else the
   rest regroups from a fresh start, as a joined utterance did). Rows in two utterances join them
   first (`mergeSubtitleLineWithNext`, same word objects, so censor marks carry). Merging again
   extends the entry; a row edit moves the entry to the row's new first/last keys
   (`followMergedRow`); re-timed keys move it like emojis (`moveWordKeyedEdits`); an entry whose
   words are gone is ignored. No mirror field was needed: add-after already splits the utterance,
   which is a hard break.
3. **Paragraph view.** `transcript/paragraph-rows.tsx`: `mm:ss` in a left column, text beside it.
   `subtitleParagraphGroups` breaks at a speaker change, a pause ≥ 0.7 s, or before 50 words (numbers
   above). Editing keeps `replaceSubtitleParagraphText`. Chips name each emoji's word; the add button
   is a hover action here (Vizard's paragraph view carries no buttons).
4. **Playhead.** `useActiveRow` (binary search `activeRowAt`, state changes only when the active row
   does) + `useFollowActiveRow` (skips while the owner scrolled in the last 3 s or is typing) in all
   three views. Word view's `indexOf` scan replaced by the same binary search.
5. **Emoji button.** `emoji/row-emoji-buttons.tsx`: add icon always shown with emojis on; the emoji's
   art in the button, with remove beside it on hover/focus; pressing opens the picker; two emojis
   stack two buttons; emojis off → add on hover. The line store addresses word ranges
   (`CaptionEmojiSpan`) and re-renders only the rows an edit touches (`caption-emoji-lines.test.ts`).
6. **No speaker labels** anywhere in the panel (static markup test asserts none).
7. **Search.** `transcript/transcript-search.ts` + header field: folds case and compatibility forms,
   ignores Arabic marks and tatweel, joins Arabic/Urdu yeh, kaf and heh; filters Sentence and Paragraph
   rows, marks matches, Enter walks matches and seeks, Escape clears.
8. **Header.** Word / Sentence / Paragraph, quiet language label, search, Auto-censor. "Transcript
   only" and its state removed (grep: nothing read it). Default view: Sentence.
9. **Read-only.** With `editingElsewhere`, row text is `readOnly`, actions and emoji controls hidden
   (emojis still shown).
10. **RTL.** Rows keep a left-to-right frame: times on the left, the emoji button at the right edge in
    both directions (Vizard's fixed edge); the text field sets `lang` and `dir` from the text.
11. **Organisation and performance.** The 1,538-line panel is gone; `transcript/`: `transcript-panel`
    (shell), `transcript-header`, `word-view` + `word-utterance` + `selection-toolbar`, `caption-rows`,
    `paragraph-rows`, `row-text-field`, `transcript-rows` (models), `transcript-search`,
    `use-active-row`, `transcript-fixture`. Row commands shared by the Studio and the prototype in
    `subtitle-row-commands.ts`. Rows memoised and matched by id; `content-visibility: auto` on rows.
12. **Tests.** See list below; `subtitle-lines.test.ts` stays green (paragraph-group tests updated on
    purpose for the new pause/length rule).
13. **See it.** `apps/web/app/prototype/subtitle-panel` (`?view`, `?emojis=some|two|none|off`,
    `?rtl=1`, `?readonly=1`, `?preset`, `?seconds`, `?t`, `?play=1`, `?search`, `?focus=<word>`).
    Screenshots below, compared with the owner's Vizard shots (copied beside them).

### Measurements (180 s fixture, 156 caption rows, Chrome against the owner's `next dev`, so a dev build of React)

| | median | runs |
| --- | --- | --- |
| Sentence view mount (switch from Word to first paint) | 602 ms | 1101, 730, 676, 586, 602, 591, 585 |
| of which textarea auto-height layout | ≈ 65 ms | 310 `scrollHeight` reads (StrictMode runs effects twice) |
| Commit, same word count (blur → paint) | 58 ms | 76, 59, 58, 57, 58 |
| Commit adding words / a caption | 100 ms | 109, 83, 100, 100, 83 (was ≈ 480 ms while rows were keyed by position) |
| Merge with next (click → paint) | 67 ms | 100, 102, 66, 63, 67 |
| Keystroke → paint | 16.8 ms | max 19.6 ms |
| Scroll whole list, 60 px a frame | p50 8.3 ms, p95 9.1 ms, max 9.3 ms | 160 frames, 0 over 20 ms |

Derivation on 180 s (bun): `deriveCaptionLines` 2.5 ms, `captionRows` 1.6 ms, `paragraphRows`
0.05 ms. Mount is dev-build React and Emotion work over 156 rows; a production build is several times
faster (not measured: `next build` is not allowed here). Windowing was not added: scrolling and
editing are within a frame, and windowing would complicate follow-the-playhead, search jumps and
focus.

### Behaviour that changed on purpose

- Sentence rows are on-screen captions (were whole utterances of up to 80 words); times read
  `mm:ss.cc – mm:ss.cc` in edited time.
- A row edit re-times only that caption's words (was: the whole utterance evenly, which changed
  every Word Key and dropped emojis and emphasis).
- **Merge with next** now keeps the two captions as one caption on the video and in the subtitle
  files (was: joined two utterances, which the video regrouped anyway); stored in the new
  `studioEdits.captionMerges`. Label "Merge with next" (was "Merge with next subtitle line").
- Paragraphs break at speaker changes, pauses ≥ 0.7 s and 50 words (were runs of one speaker).
- No speaker labels; "Transcript only" checkbox removed; Sentence is the default view.
- Playhead highlight and follow-scroll in Sentence and Paragraph; search added.
- Readers (someone else holds the lease) can no longer type into rows.
- Paragraph add-emoji button shows on hover only.

### Tests

composition-plan `caption-lines.test.ts` (115 presets × lines = cues; merges: 115 presets ×
merged words one caption, neighbours unchanged, ignored when words are gone, cut word inside);
web `subtitle-row-edits.test.ts` (same/different count, emptied, add after with split, Urdu, Chinese
per-character, cut words, Word-Key addressing, emojis/emphasis/censor marks kept, one undo step),
`subtitle-row-merge.test.ts` (same utterance, across utterances with word objects kept, merge again,
edit a merged row, emojis and emphasis survive, one undo step, last row / mixed timing, scene-split
refusal, every merge on the 180 s fixture for Bold Pop and Headline), `subtitle-lines.test.ts`,
`transcript/transcript-rows.test.ts` (active-row binary search vs linear scan, search incl. Urdu,
Arabic marks, Hindi forms, row identity on edits), `transcript/caption-rows.test.tsx` (static markup:
no emoji, one, two, emojis off, read-only, active, RTL, last row's merge disabled),
`emoji/caption-emoji-lines.test.ts`, `emoji/emoji-chips.test.tsx`.

Commands (final): `bun run typecheck` 17/17 successful; `bun run test` 16/16 successful (first run
had one `audio-panels.test.ts` 30 s timeout under parallel load, not this ticket's file; it passes
alone in 4 s and the rerun was all green); validators 1,366 pass; composition-plan 437 pass; apps/web
1,459 pass; `bun run check:web-split` passed; `bunx biome check` on every touched file: clean.

### Screenshots (`SHOTS`)

`sentence-some.png` (active row with emoji), `sentence-two-focus.png` (two emojis, remove beside the
focused one, row actions shown), `sentence-merged.png` ("We threw" merged with "a huge party", the
rows after unchanged), `sentence-none.png`, `sentence-off.png`, `sentence-readonly.png`,
`sentence-rtl.png`, `sentence-search.png`, `sentence-headline.png`, `sentence-reveal.png`,
`paragraph.png`, `paragraph-rtl.png`, `word.png`; the owner's references copied beside them:
`vizard-sentence.png`, `vizard-paragraph.png`, `vizard-emoji-hover.png`. Compared: row rhythm about
66 px a row against Vizard's 74 px (slightly tighter; more captions fit on screen); time 12 px subtle grey above 14 px text, as Vizard; emoji buttons a
single 32 px column down the right edge; active row on the accent-subtle surface with its time in
accent, as Vizard's paragraph highlight.

### Not this ticket's, found on the way

- `studio-shell.tsx` still builds a `transcript` field (`derivedTranscript`, "for existing
  TranscriptPanel") that nothing reads; it was already unread before this ticket. Left alone in the
  shared shell.
- Exports pick up merges only once the media image carries this composition-plan (deploy order as
  usual: API, Modal, web).

