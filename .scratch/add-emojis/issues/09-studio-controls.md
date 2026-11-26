# 09 - Studio controls: Emojis section, word chips, line chips, picker

**What to build:** Everything the owner does with emojis in the Studio. Rules:
[../RULES.md](../RULES.md). Spec D9 and section 4.

**Blocked by:** [05 - AI tagging](05-ai-tagging.md), [07 - Studio preview](07-studio-preview.md)

**Status:** done

## Areas

`studio/_components/emoji/**` (new files), mount points in
`tool-panels/captions-panel.tsx`, `transcript-panel.tsx` and `studio-shell.tsx` (dispatch wiring).
Keep the feature's code in the `emoji/` folder; the large files gain only a mount point and props.

## Deliverables

1. `emoji/emoji-glyph.tsx`: draws one design from its compiled layers as inline SVG in a given
   palette and tone (used by chips, the picker and the palette swatches). Art comes from the shared
   art hook of ticket 07.
2. `emoji/emojis-section.tsx`, mounted in the captions panel's Customize tab for every preset kind
   (classic, Dynamic, Scene):
   - Switch "Emojis" (writes `preset.emojis` through the existing `setCaptionPreset` path).
   - When on with no emojis: "Add with AI" primary action with a density choice (Light, Balanced,
     Expressive; Balanced selected). While running: the button shows progress; errors use the
     panel's existing error presentation with the route's typed codes. An empty result shows "No
     emojis fit this clip".
   - When emojis exist: count, "Regenerate" (confirm when any emoji was placed by hand; one undo
     step via `replaceCaptionEmojis`), "Remove all" (one undo step).
   - Style: Colours (Match template, the four palettes from `CAPTION_EMOJI_PALETTES` drawn as
     small three-colour swatches, Custom with three colour pickers labelled Body, Accent, Detail,
     reusing the panel's colour control), Size (S, M, L), Position (Auto, Above, Below), Sticker
     outline (switch). All write preset fields, so Apply to all and brand templates carry them.
   - "On screen now": the live cue's words as chips, modelled on `EmphasisSection`
     (`captions-panel.tsx` about 1091-1157, `useLiveCaptionLayer`). A word with an emoji shows it;
     tapping a word opens the picker to add, replace or remove. RTL cues lay out right to left.
   - The read-only (write lease) case uses `ReadOnlyPanelNotice` like the other sections.
3. `emoji/emoji-picker.tsx`, a lazy chunk (`next/dynamic`), in a popover:
   search over name, keywords and glyph (so pasting 🔥 finds the design); group tabs from
   `CAPTION_EMOJI_GROUPS` including Phrases; recents (localStorage, wrapped in try/catch, per
   browser); a skin-tone selector that applies to designs with tones and is remembered; Remove when
   the target has an emoji. The grid is virtualised (rows rendered on demand; art shards fetched
   for visible groups only). Keyboard: arrows move, Enter picks, Escape closes; focus returns to
   the trigger. Glyphs drawn in the clip's current palette.
4. `emoji/line-emoji-chips.tsx`, mounted in each subtitle line row of `transcript-panel.tsx`
   (`SubtitleLineEditor`, about line 658, next to the `LineAction` group at about 716-726, and the
   paragraph variant about 757): the line's emojis as chips (glyph plus anchor word); a hover
   action "Add emoji" that anchors to the line's word under the playhead if the playhead is inside
   the line, otherwise the line's strongest word (hero role) or its last word. A chip opens the
   picker (replace, remove).
5. `emoji/use-caption-emojis.ts`: the one hook the three surfaces use: reads
   `studioEdits.captionEmojis`, resolves entries to current words with
   `resolveCaptionEmojiAnchors`, dispatches `setCaptionEmojis` / `replaceCaptionEmojis`, calls the
   suggest mutation. Dispatch wiring in `studio-shell.tsx` follows `setCaptionEmphasis` (about
   1504-1518): one undo step per gesture.
6. Apply to all: nothing to add in the client beyond the existing caption apply (the preset
   carries the fields; ticket 11 fills emojis on the server).
7. Tests: the hook's reducer wiring, picker search (name, keyword, glyph, no result), anchor choice
   for a line add, section states (off, on without emojis, on with emojis, read-only), RTL chip
   order. Follow the test style of `captions-panel-model.test.ts` and the transcript tests.
8. Verify in a browser on the prototype page from ticket 07 or a Studio page if an API is
   reachable; screenshots of the section, the picker (open, searching, skin tones) and line chips
   to the scratchpad
   (`/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-studio/`).
   Check light and dark themes.
9. Budget: picker open time and search keystroke time over all designs; confirm the picker and
   the index are separate lazy chunks.

## Acceptance

- [x] Deliverables 1 to 9.
- [x] `captions-panel.tsx` and `transcript-panel.tsx` grew only by mount points and props.
- [x] `bun run lint`, `bun run typecheck`, web tests, `bun run check:web-split`.

## Evidence

Implemented 2026-11-26. Nothing committed.

### Files (`studio/_components/emoji/`, all new unless noted)

- `caption-emoji-words.ts`: the words an emoji can sit on (Word Key, text, line, edited time, cut,
  censored), placement by the plan's anchor rule, "On screen now" chips (Scene and Dynamic cues by Word
  Key; classic cues matched by time and letters), line targets, the line Add anchor, hero keys, and
  `keepShownSuggestions`.
- `caption-emoji-runs.ts`: per-clip session store outside React: the AI run state (idle, running,
  added, empty, failed), density, hand-edit baseline, `runCaptionEmojiSuggestion`,
  `mergeCaptionEmojiSuggestion`.
- `use-caption-emojis.ts`: `CaptionEmojiSource` (what the controls read and write) and
  `useCaptionEmojiEditor`, the one hook the section, word chips and line chips use.
- `studio-caption-emojis.tsx`: Studio wiring (session document, dispatch, save, suggest route) and
  `StudioLineEmojiChips`. `studio-emojis-section.tsx`: `StudioEmojisSection` (kept apart so the
  section's code stays in the Captions panel's lazy chunk).
- `emojis-section.tsx`: the Emojis section (all states). `emoji-style-controls.tsx`: Colors, Size,
  Position, Sticker outline, `EmojiSwitch`.
- `emoji-chips.tsx`: `LiveCueEmojiChips`, `LineEmojiChips` (chip, hover remove, hover Add).
- `emoji-glyph.tsx`: `EmojiArtSvg`, `EmojiGlyph`, `captionEmojiSvgMarkup` (cached markup for the grid).
- `emoji-picker-host.tsx`: one popover for every control (`openEmojiPicker`, `CaptionEmojiPickerHost`,
  `warmEmojiPicker`). `emoji-picker.tsx` (lazy chunk) + `emoji-picker-parts.tsx` (virtual grid, skin
  tones) + `emoji-picker-model.ts` (search, layout, grid keys, recents, tone memory).
- `use-caption-emoji-index.ts`: the catalog index as a dynamic import, for chip names.
- `use-caption-emoji-art.ts` (ticket 07's, +4 lines): `preloadCaptionEmojiArt`.
- `caption-emoji-fixture.ts` (ticket 07's): split into `emojiFixtureDocument` + `emojiFixtureLayersFor`
  (same output for `emojiFixtureLayers`).
- Tests: `caption-emoji-words.test.ts` (13), `use-caption-emojis.test.tsx` (11),
  `emoji-picker-model.test.ts` (12), `emojis-section.test.tsx` (8).

Mount points: `studio-shell.tsx` (+27: `setCaptionEmojis`, `replaceCaptionEmojis`, `checkpointCloud`
on the context, one `<CaptionEmojiPickerHost />`); `captions-panel.tsx` (+2: import, one mount line in
Customize passing its `ColorField`); `transcript-panel.tsx` (+1 import, one mount line in the subtitle
line header, the paragraph header wrapped in a Flex with one mount line).

### Behaviour decisions

- Unsaved caption edits vs the suggest route: before calling, the Studio saves through the session's
  `checkpoint-cloud` (waits at most 6 s; a save that cannot finish does not block). When the answer
  arrives, picks are re-resolved against the current words and any pick that lands on a cut, censored
  or missing word is dropped (`keepShownSuggestions`). Edits made to emojis while the request was out
  win over the answer (`mergeCaptionEmojiSuggestion`). An empty answer never deletes existing emojis.
- Hand-edited = the emojis differ from the last AI result (or from what they were before the first
  hand edit this session). Undoing back to it clears the flag; Regenerate then asks with an inline
  confirm ("Replace your emoji edits?").
- The AI run lives outside React, so closing the Captions panel mid-run still applies the result; a
  tab that lost the write lease meanwhile applies nothing and says so.
- Read-only: the panel already shows `ReadOnlyPanelNotice` (tool sidebar); the section's controls are
  `inert` and dimmed, the switch is disabled, chips do not open the picker. Not shown twice.
- Line Add anchor: the word under the playhead if the playhead is in the line, else the hero word,
  else the longest word (later on a tie) instead of the last word (last words are mostly "to", "it");
  words that already hold an emoji are passed over while another is free.
- Adding by hand while emojis are off turns them on (two undo steps: switch, then the emoji).
- Dub captions: chips show but take no target, with a note to use the original lines.

### Budget (measured)

Headless Chrome via chrome-devtools on the dev server (dev React, unminified), prototype page:
- Picker open (click to 40+ drawn cells): first open 116 ms, then 67-82 ms (8 opens). Before the
  fixes below it was 359-434 ms first and ~100-130 ms after.
- Search keystroke (input event to commit, 42 keystrokes over "m", "money bag", "fire", 🔥, "happy",
  clear): median 28 ms, p90 36 ms, max 49 ms. The search itself over 1,408 designs: 0.11 ms median,
  0.24 ms p99 (Bun, `search-bench.ts`); index build 2.4 ms once. The rest is React dev rendering.
- Fixes found by measuring: grid cells as memoised plain elements with one stylesheet and cached SVG
  markup (clear 70 to 35 ms); one render per keystroke (no reset effect); the picker renders directly
  once its chunk is in (going through `next/dynamic` again showed the fallback and React holds a
  revealed fallback 300 ms); the section warms the chunk and the first screen of art 800 ms after it
  shows.
- Chunks (dev server, `?state=off`): the 63 initial scripts contain no picker code, no index data and
  no art. Turning emojis on and opening the picker loads the picker chunk, the index chunk and the
  smileys art shard only. By import graph the only static runtime import of
  `@narriflow/caption-emoji/index` is `emoji-picker.tsx`; the dev build also inlined the index into the
  picker chunk (a production split could differ; no `next build` was run, banned).

### Browser check

Prototype: `http://localhost:3100/prototype/caption-emoji-controls` (dev only; real section, chips,
transcript rows and picker with local undo history and a stubbed suggest; parameters in `page.tsx`:
`state`, `suggest`, `preset`, `rtl`, `t`, `open`, `search`, `tone`, `run`, `confirm`, `mode`).
Screenshots in
`/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-studio/controls/`:
off, none, running, added, empty, error, offline, confirm, readonly, nowords, some (dark), the same
key states in light (`*-light.png`), picker open from a word chip / line chip / Add, searching
(money), pasted glyph (🔥), skin tones (thumbs, medium-dark), no match, RTL (Urdu chips right to left,
picker LTR), Scene (Horizon) and Dynamic (Headline). The Studio chrome is graphite in both color
modes by design (`studio.*` tokens are mode-invariant), so light and dark differ only outside it.
Fixed after looking: chip remove gap, empty live-region gap, dark swatch dots invisible on graphite
(Retro), tone selection ring too faint, Add button vanishing while its picker is open.

### Commands

- `bun run typecheck`: 17 of 17 successful.
- `bun run --cwd apps/web test`: 1,309 pass, 0 fail (44 new).
- `bun run check:web-split`: passed.
- `bun run lint`: 168 errors, none in a file this ticket touched (same set earlier tickets recorded:
  `.scratch/**`, `narriflow-emoji-prototype.html`, two web CSS files, a prototype HTML).
  `bunx biome check` on every touched file: clean.

### Not covered

- No Studio page was opened against an API (none reachable without sign-in); the Studio adapter is
  covered by typecheck and the same components run in the prototype.
- The Captions panel's own preview card still draws no emojis.
- Hover reveals (line remove, Add) cannot be shown in a static screenshot; verified in the DOM.
