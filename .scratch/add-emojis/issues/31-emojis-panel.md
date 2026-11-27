# 31 — Emojis get their own Studio panel

Status: done
Depends on: 25 (AI tools panel)

## Why

Owner, 2026-11-27, on the AI tools row "Add emojis › 1 emoji": "when i click on the Emojis tab it goes
inside the Caption Panel. Rather is should be inside the Emojis panel. Also see the should be changed
and restructure in the emoji settings view".

Today the row calls `openTool({ tool: "captions", section: "emojis" })`, so the user lands at the bottom
of the Captions panel's Customize tab, under every caption control, with the caption preview pinned on
top and the Captions "Apply to all clips" button under the emoji settings. Emojis are an AI tool with
their own settings; they should have their own panel, like Auto-censor has.

## What to build

All paths are under `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/`.

### 1. A new child tool "Emojis"

- `ToolId` gains `"emojis"`. In `tool-sidebar.tsx`: a `TOOLS` entry `{ id: "emojis", label: "Emojis",
  icon: <Smile …/>, parent: "ai" }` and a `PANEL_MAP` entry for a new `tool-panels/emojis-panel.tsx`,
  loaded with `dynamic` like the others. It has no rail button; the panel header shows the back arrow to
  AI tools and the AI tools rail button stays selected (both already follow from `parent`).
- AI tools row (`tool-panels/ai-tools/emoji-row.tsx`, `emojiRowView` in `ai-tools-model.ts`):
  - no emojis and no finished run: **Apply**, as today;
  - emojis exist: count and chevron, opening the **Emojis panel** (`openTool("emojis")`);
  - the last run finished with none: "No emojis fit this clip" with a **chevron** to the Emojis panel
    (not Apply again), because the panel is where the user can pick another density or add one by hand.
  - a failed run keeps today's error line and Try again.
- The Captions panel no longer contains the Emojis section: remove the `StudioEmojisSection` mount and
  the `"emojis"` member of `CaptionsPanelSection` (`tool-target.ts`), with whatever only it used
  (`captionsPanelTab`, `revealPanelSection` stay for `"emphasis"`). Captions' own "Apply to all clips"
  stays where it is and still carries the emoji preset fields; do not add an Apply to all to the
  Emojis panel.
- The emoji colour pickers need the Captions panel's `ColorField` (a local function in
  `captions-panel.tsx`). Move it to its own module beside `panel-ui.tsx` and import it from both
  panels, unless a shared colour field already exists that looks the same; do not copy it.
- Any other place that opens the emoji section (`grep` for `section: "emojis"` and for links from the
  transcript rows or the picker) opens the new panel instead.

### 2. The panel's layout, top to bottom

One scroll column, `PANEL_PX` padding, sections `gap` 6, existing parts reused
(`EmojisSection` is rebuilt from its own pieces; keep its logic: `emojisSectionView`,
`emojiRunFailure`, `RunButton`, `RunMessage`, `RegenerateConfirm`).

1. **Show emojis** — one soft row (the look of the Skin tone row: `studio.subtle`, radius 12): label
   "Show emojis", the `EmojiSwitch` at its end. Off: under it the line "Stickers above your captions,
   drawn in your caption colors." and nothing else in the panel. No caption words: the existing
   "no caption words" line and nothing else. "Subtitles are hidden, so emojis are hidden too." stays as
   a note under the row when it applies.
2. **Add with AI** (section label) — the density control (Light / Balanced / Expressive), under it one
   quiet line that describes the selected density in words (move the three `title` texts into that
   line; keep them as `title` too), then the button: "Add with AI" when the clip has none,
   "Regenerate" when it has some (with the existing replace confirmation), then the run messages
   exactly as today.
3. **In this clip** (section label with the count, e.g. "In this clip · 6", and "Remove all" as the
   label's action) — a list of every emoji the clip shows, in time order. One row per emoji: the emoji
   drawn in the clip's palette (the same glyph component the chips use), the word it sits on, and its
   time in the edited clip as `m:ss` at the row's end. Clicking a row seeks the playhead to that word
   (use what the transcript rows use to seek) and the row under the playhead is marked as current.
   Each row has the two actions the chips already have: change (opens the emoji picker anchored to the
   row) and remove (one undo step, through `editor.place(target, null)`). Rows are soft, no borders,
   32 to 36 px high; right-to-left words render right-to-left (`dir="auto"`). With no emojis the
   section shows one line: "No emojis yet. Add with AI, or tap a word below." An emoji on a word that
   is cut or censored is not shown on screen: leave it out of the list (the count already excludes it).
4. **Add to a word** (section label; this is today's "On screen now") — the `LiveCueEmojiChips` of the
   caption under the playhead, unchanged, with the quiet line "Words on screen now. Tap one to add an
   emoji." above the chips.
5. **Style** (section label) — `EmojiStyleControls` unchanged: Colors, Size and Position, Skin tone,
   Sticker outline.

Read-only (another tab holds the write lease): sections 2 to 5 are inert and dimmed, as today.

### 3. Rules

- Read `AGENTS.md` (root and `apps/web`), `.scratch/add-emojis/RULES.md` and the UI taste: no borders
  anywhere, soft fills, `studio.*` tokens only, blue accent for selected/current state, no green.
  Chakra UI v3. No new dependency.
- Keep the files small: the new list is its own component file with its pure part (rows from
  `editor.model` and `editor.placement`, the current row for a time) in a `.ts` module with tests.
- Do not change emoji placement, the AI run, the picker, or anything outside `apps/web`. Another
  ticket (30) is changing `packages/validators` and `packages/services` at the same time; do not touch
  them. If you must change the density hint texts, keep them free of numbers so ticket 30 can change
  the spacing without touching your file.
- Shared checkout: other sessions have uncommitted work here. Do not commit, stash, reset or restore
  anything; do not touch files this ticket does not need.
- Never start, stop or restart a dev server. The owner's server is listening on port 3000; you may read
  pages from it. To look at your panel, you may add a temporary page under `app/prototype/` that mounts
  the panel with `emoji/caption-emoji-fixture.ts`, screenshot it with headless Chrome
  (`"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --screenshot=… 
  --window-size=420,1100 --virtual-time-budget=8000 <url>`), look at the picture, and delete the page
  before you finish. If the page cannot be made to work in 20 minutes, skip it and say so.
- No PostgreSQL gates, no `next build`, no heavy suites.

## Done when

- The AI tools row opens the Emojis panel; nothing opens the Captions panel for emojis; the Captions
  panel has no Emojis section; `"emojis"` is gone from `CaptionsPanelSection`.
- The panel has the five sections above in that order and the list seeks, changes and removes.
- Tests: `ai-tools-model.test.ts` covers the three row states; `ai-tools-panel.test.tsx` covers the
  new tool (child of AI tools, no rail button, back arrow); the list's pure module has tests (order,
  cut and censored words left out, current row); the old `emojis-section.test.tsx` cases still pass
  against the new panel.
- `bun run --cwd apps/web typecheck`, the web tests for the files you touched and
  `bunx biome check` on the files you touched pass. `bun run check:web-split` passes.
- Write an **Evidence** section at the end of this file: what changed (files), test output counts,
  whether you saw the panel rendered (attach the screenshot path) and anything you left undone.

## Evidence

Paths are under `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/`.

### What changed

- `studio-shell.tsx`: `ToolId` gains `"emojis"` (one line).
- `tool-sidebar.tsx`: `TOOLS` entry `{ id: "emojis", label: "Emojis", icon: <Smile/>, parent: "ai" }` and a `dynamic` `PANEL_MAP` entry.
- `tool-panels/emojis-panel.tsx` (new): Studio wiring. It passes the editor, the live cue, and a timeline (`playbackClock`, `compositeToBaseEdited`, `baseEditedToComposite`, `seekTo`) to `EmojisSection`.
- `emoji/emojis-section.tsx`: `EmojisSection` rebuilt from its own pieces as the five sections. The logic is unchanged (`emojisSectionView`, `emojiRunFailure`, `RunButton`, `RunMessage`, `RegenerateConfirm`). The density hints have no numbers ("Only the surest matches, spaced well apart.", "Clear matches at an easy pace.", "Every good match, close together."). They show as the line under the control and stay as `title`. New prop: `timeline: EmojiListTimeline`.
- `emoji/caption-emoji-list.ts` (new, pure): `captionEmojiListRows(model, placement): CaptionEmojiListRow[]` and `currentCaptionEmojiRow(rows, playheadSec): number`.
- `emoji/emoji-list.tsx` (new): `EmojiList({ editor, timeline })`. Rows are 34 px with a soft `studio.subtle` fill and no borders. The current row (and the row whose picker is open) takes `studio.accentSubtle`. Clicking the emoji opens the picker anchored to the row. Clicking the word seeks to `baseEditedToComposite(word start)`, the same mapping the transcript's word view uses. The time shows as `m:ss` (`formatDuration`) in composite time. On hover or focus a Remove button takes the time's place; it calls `editor.place(target, null)`. Words have `dir="auto"`.
- `emoji/emoji-chips.tsx`: `openPickerFor` is now exported so the list reuses it. No other change.
- `tool-panels/color-field.tsx` (new): `ColorField`, moved out of `captions-panel.tsx` unchanged. Both panels import it. The only other colour field (`text-style-controls.tsx`) is a round swatch with a different look, so it was not reused.
- `tool-panels/captions-panel.tsx`: the Emojis section mount and the local `ColorField` are removed; four unused Chakra imports dropped. Captions' Apply to all is untouched.
- `tool-target.ts`: `CaptionsPanelSection = "emphasis"`. `captionsPanelTab` and `revealPanelSection` stay. `tool-target.test.ts` now uses `"emphasis"`.
- `tool-panels/ai-tools/ai-tools-model.ts` (`emojiRowView`): a finished run with no emojis now returns `{ kind: "open", description: "No emojis fit this clip" }`. `emoji-row.tsx` opens `openTool("emojis")`. A failed run on a clip with no emojis keeps Apply plus Try again, as before.
- `emoji/studio-emojis-section.tsx`: deleted, since the Emojis panel replaces it. Comments in `studio-caption-emojis.tsx` and `emoji-style-controls.tsx` were updated.
- A grep for `section: "emojis"` and `StudioEmojisSection` across `apps/web` finds nothing. The transcript rows and the picker never opened the section.

### Tests and checks

- `emoji/caption-emoji-list.test.ts` (new, 8 tests): time order regardless of storage order; cut words left out with later times shifting; censored words left out; RTL words; no emojis; the current row, including after a seek that lands a hair early; no current row before, between or after words.
- `emoji/emojis-section.test.tsx`: 17 pass. All 12 old cases still pass against the new layout, with the copy updated: "In this clip · 4" instead of "4 emojis", and "Words on screen now…" instead of "On screen now". 5 new cases: section order, density line without numbers, subtitles-hidden note, list rows (order, `m:ss`, change, remove, `dir="auto"`), and the current row.
- `tool-panels/ai-tools/ai-tools-model.test.ts`: the three row states (Apply / open with count / open with "No emojis fit this clip"), plus failed runs.
- `tool-panels/ai-tools-panel.test.tsx`: the done-empty row has a chevron, not Apply; the chevron calls `openTool("emojis")` both with emojis and after an empty run; Emojis is a child of AI tools with no rail button; a rendered `ToolSidebar` shows "Back to AI tools" with only AI tools selected; 11 tools, 9 rail buttons.
- `bun test` on `emoji/`, `tool-panels/`, `transcript/`, `tool-target.test.ts` and `studio-dead-ends.test.tsx`: **284 pass, 0 fail** (29 files).
- `bun run --cwd apps/web test` (whole web suite): **1536 pass, 0 fail** (199 files).
- `bunx biome check` on the 19 touched files: clean.
- `bun run check:web-split`: passed.
- `bun run --cwd apps/web typecheck`: **0 errors in apps/web**. It still exits 2 because of 11 errors in `packages/services` (`brand-font.service.ts`, `brand-profile.service.ts`, `brand-template.service.ts`, `campaign-operation.service.ts`). They concern a brand template `title` field from another session's uncommitted work. Same result on two runs several minutes apart. Not touched.

### Seen rendered

I saw the panel on a temporary `app/prototype/emojis-panel` page, mounted over `emoji/caption-emoji-fixture.ts` and screenshotted with headless Chrome. The page is deleted.

- `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f087f47d-e3dd-475b-9b96-45da9b2eca42/scratchpad/emojis-panel.png`: all five sections in order. Playhead on "money", so that row is current (blue).
- `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f087f47d-e3dd-475b-9b96-45da9b2eca42/scratchpad/emojis-panel-rtl.png`: Urdu words render right to left in the list and the chips.
- `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f087f47d-e3dd-475b-9b96-45da9b2eca42/scratchpad/emojis-panel-empty.png`: no emojis. Add with AI, the hand-placement hint and "No emojis yet. Add with AI, or tap a word below."

### Left undone or uncertain

- The prototype page logged a hydration mismatch. It came from emotion's class on Chakra's `Stack` during SSR of the prototype route (`className` null on the server versus `chakra-stack …` on the client), not from the panel's markup. When bisected, the list, chips, style controls, switch and segmented control each hydrated cleanly. The Studio panel only mounts on the client, after a tool opens, so this cannot happen there. It has not been checked in the live Studio.
- The current row is the emoji whose word the playhead is on. Between words no row is current.
- The emoji picker's move-to-another-word list is not offered from list rows, only change and remove, as the ticket asks.

