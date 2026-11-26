# 25 - An AI tools panel in the Studio

**What to build:** A new first item in the Studio's tool rail, "AI tools", whose panel lists the
AI actions the Studio already has, each as a row with an icon, a title, one line of description and
either an Apply button or a chevron that opens the tool's own panel. The owner's reference is
Vizard's AI tools panel
(`/Users/murtaza/.t3/userdata/attachments/c6bf7fda-c97e-4ad5-a81a-35b14c64dc87-15afe8aa-8f89-499c-aefe-0df4f47ad165.png`,
and the earlier `…-cdb5418f-247a-466b-b7d0-e74d5f81a6a4.png` and
`…-5595ef5d-4f53-448e-9e65-2b5fcf81a25e.png` for its running state). His words: "there should be
the Ai Tools panel which Will have the Tools for example: Add Emojis, Auto Censor etc. like vizard
ai." Rules: [../RULES.md](../RULES.md).

**Blocked by:** None (tickets 22 and 23 are running in neighbouring files; see ownership below).

**Status:** done

## What exists (read-only map; verify before relying on line numbers)

`S/` = `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/`.

- Rail: `S/tool-sidebar.tsx` (`TOOLS`, `PANEL_MAP`, lazy panel imports, the panel header and
  `ReadOnlyPanelNotice`), `ToolId` in `S/studio-shell.tsx`, `activeTool` / `setActiveTool`. Nine
  tools today; the rail compacts under 900 px and 760 px of height. Panel kit:
  `S/tool-panels/panel-ui.tsx`. No way to open a panel on a given tab or section.
- Add emojis: `useStudioCaptionEmojiEditor()` (`S/emoji/studio-caption-emojis.tsx`) gives the
  editor (`generate(density)`, `setEnabled`, `removeAll`, `placement.shown`, `confirmRegenerate`);
  the run is a per-clip store outside React (`S/emoji/caption-emoji-runs.ts`:
  `useCaptionEmojiSession(clipId)`, states idle, saving, running, done, failed;
  `captionEmojiRunBusy`), so two surfaces show the same run. The answer commits through a mounted
  editor; with none mounted it fails as `closed`.
- Remove silences: only in the timeline (`RemoveSilencePopover` in `S/timeline.tsx`), a pure client
  edit: `detectSilenceRanges(...)` from `@narriflow/validators` with the Studio's `quietRanges`
  (null when the audio was not measured: transcript gaps only), then `applyRemoveSilence`
  (`studio-shell.tsx`), one undo step. It does not check the dispatch receipt.
- Remove filler words: pure functions exist (`detectFillerWordRanges`, `detectClipCleanupRanges`),
  English word list only; other languages need AI tags that are not in the Studio. No Studio
  control today.
- Auto-censor: `S/tool-panels/censor-panel.tsx`. The scan (`detectAutoCensorSuggestions`) is pure
  and free; applying is gated on `editor.censoring` (`StudioLockGem`, `openUpgrade`).
- Auto reframe: no clip-level button; the Layout panel's preset grid with "Apply to all scenes" and
  preset `auto` does it (`applySceneLayoutChoice`, `removeSpeakerLayoutOverrideRange`). New clips
  are already Auto. Speaker analysis is server-side and may be pending, available or failed.
- Emphasize keywords: a property of Dynamic and Scene styles with a hero word; the Captions panel's
  Customize tab has an Emphasis section for the cue under the playhead. No switch.
- B-roll: `S/tool-panels/broll-panel.tsx` (stock search, generated images); one cutaway per clip;
  nothing one-click.

## Deliverables

1. **The rail item and panel.** `ai` (label "AI tools") as the first rail item, with an icon that
   is not the `Sparkles` used on AI buttons inside panels (for example lucide `WandSparkles`).
   Check the rail at 900 px, 760 px and 680 px of height with ten items and adjust its compact rules
   if the last item is cut. The panel lists rows in this order; a row whose tool cannot work for
   this clip is left out, not greyed (the owner's rule: no dead controls):

   | Row | Description line | Control |
   | --- | --- | --- |
   | Add emojis | "AI adds emojis that match what is said" | Apply |
   | Remove silences | "Cut the gaps between sentences" | Apply |
   | Remove filler words | "Cut ums and uhs" | Apply (English clips only; left out otherwise) |
   | Auto reframe | "Keep the speaker in frame" | Apply, or a quiet "On" when the whole clip is already Auto |
   | Auto-censor | "Mask sensitive words" | Opens the Censor panel |
   | Emphasize keywords | "Highlight the words that matter" | Opens Captions on its Emphasis controls |
   | B-roll | "Add visuals over your clip" | Opens the B-roll panel |

2. **Row behaviour.**
   - **Add emojis.** Apply turns emojis on if they are off and runs the same AI run the Emojis
     section runs (Balanced), through the shared per-clip run, so both surfaces stay in step. The
     button shows progress inside itself while saving and running; the rest of the panel stays
     usable (Vizard blocks the whole list; do not). When emojis exist the row shows the count
     ("12 emojis") and its control becomes a chevron that opens Captions on the Emojis section
     (edit, regenerate, remove, colours live there). Errors use the section's typed messages
     (`emojiRunFailure`) inline under the row with a retry. The panel mounts the emoji editor so an
     answer can commit while it is open.
   - **Remove silences.** The description line shows what Apply would do, live ("7 silences, 4.2 s
     shorter"), computed with the timeline popover's default settings from one shared function
     (move the defaults next to it; the popover and this row must not each hold a copy). Apply is
     the same single undo step. With nothing to cut the row says "No silences found" and has no
     button. Check the dispatch receipt (fix `applyRemoveSilence` for both callers): if the edit
     was refused, say so instead of pretending.
   - **Remove filler words.** Same pattern, English clips only, using the existing pure detection.
     One undo step. If the count is zero, "No filler words found".
   - **Auto reframe.** Apply sets the whole clip's layout to Auto with the same helper the Layout
     panel uses. Show the speaker-analysis state the Layout panel shows (pending or unavailable)
     as one quiet line. When every scene is already Auto, the row shows "On" and a chevron to the
     Layout panel.
   - **Auto-censor.** The row shows the free scan's count ("3 words found") and a chevron to the
     Censor panel; the plan gem appears on the row when applying is gated, as in that panel.
   - **Emphasize keywords.** Chevron to Captions, opened on the Customize tab at the Emphasis
     section when the current style has a hero word; when it does not, the row is left out.
   - **B-roll.** Chevron to the B-roll panel.
3. **Opening a panel at a place.** A small, typed mechanism in the shell: opening a tool may carry
   a target (for example `{ tool: "captions", section: "emojis" | "emphasis" }`), which the
   Captions panel reads once to choose its tab and scroll the section into view. No global event
   bus; keep it to what these rows need.
4. **Read-only and gating.** When someone else holds the write lease, Apply buttons are not shown
   (chevrons still open panels) and the existing notice explains. Follow the censor panel's
   pattern for the plan gem.
5. **Organisation.** `S/tool-panels/ai-tools-panel.tsx` renders rows from small per-tool hooks or
   descriptors in `S/tool-panels/ai-tools/` (one file per tool, each returning the row's state:
   description, control, busy, error), with a pure model for anything computed. No tool's logic is
   copied from its own panel: share the function and have both call it.
6. **Tests.** Pure models (silence and filler row states, reframe "already on", which rows show
   for which clip); static-markup tests of the panel with a mocked shell in the style of
   `S/studio-dead-ends.test.tsx` (rows shown, read-only, gated censor row, emoji row in each run
   state); the panel-target mechanism; and a test that every `ToolId` has a `TOOLS` entry and a
   panel.
7. **See it.** A prototype page mounting the panel with mock state for every row state. Do not
   start a dev server; if `http://localhost:3000` answers (the owner's server) load the prototype
   from it read-only and screenshot with headless Chrome directly. Save beside the owner's Vizard
   reference in
   `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/ai-tools/`
   and compare: row rhythm, icon and title weight, the Apply button's size and alignment down the
   right edge. Narriflow's look: graphite Studio, no borders or divider lines (use spacing or soft
   row surfaces), soft filled buttons, accent only for interactive state.

## File ownership (two other builders are running)

- Ticket 22 owns the transcript panel files, `S/subtitle-lines.ts`, the transcript dispatchers in
  `S/studio-shell.tsx`, and `S/emoji/{emoji-chips.tsx,studio-caption-emojis.tsx,caption-emoji-lines.ts,caption-emoji-words.ts}`.
- Ticket 23 owns `S/emoji/{emojis-section.tsx,emoji-style-controls.tsx,emoji-picker*.tsx,use-caption-emojis.ts,caption-emoji-runs.ts,emoji-glyph.tsx}`.
- You own the new panel files, `S/tool-sidebar.tsx`, the `ToolId` union and the panel-target
  mechanism in `S/studio-shell.tsx`, the Captions panel's reading of the target, and the silence
  defaults shared with `S/timeline.tsx`. In files you share (`studio-shell.tsx`,
  `captions-panel.tsx`) use targeted edits and re-read right before each edit; read the emoji
  editor and run modules but do not edit them (if you need a small additive export, make it and
  report it).

## Acceptance

- [x] Deliverables 1 to 7; screenshots and the list of behaviour changes in Evidence.
- [x] `bun run typecheck`, web tests, `bun run check:web-split`, biome on touched files.

## Evidence

Implemented 2026-11-26 by two agents: the first wrote most of the code and was cut off by a usage
limit before tests, prototype or Evidence; the second checked every file, fixed what is listed
under "Fixed in the second pass", and wrote the tests, prototype, screenshots and this section.
Nothing committed. `S/` as above.

### Rows as built (`S/tool-panels/ai-tools/`, one hook per row, pure decisions in `ai-tools-model.ts`)

| Row | States |
| --- | --- |
| Add emojis (`emoji-row.tsx`) | Apply ("AI adds emojis that match what is said"); busy: spinner inside the button, description "Saving your edits first" while saving; done with emojis: "12 emojis" (or "3 emojis, turned off") + chevron to Captions › Emojis; done empty: "No emojis fit this clip" + Apply; failed: `emojiRunFailure` message under the row, "Try again" only while the clip has no emojis (a failed Regenerate retries from the section, where its confirmation lives); hidden when no caption word shows. Apply turns emojis on if off, then `editor.generate(editor.density)`: the shared per-clip run at the section's density (Balanced unless changed there). |
| Remove silences (`silence-row.tsx`) | "2 silences, 3.7 s shorter" + Apply; "No silences found" with no button. Apply = `applyDetectedCuts(ranges)`, one undo step; success toast only when the session accepted it. |
| Remove filler words (`filler-row.tsx`) | English only (any `en-*`; left out otherwise, `listFillerClassifier`). "3 filler words, 1.3 s shorter" + Apply; "No filler words found". One undo step. |
| Auto reframe (`reframe-row.tsx`) | Apply ("Keep the speaker in frame"); "On" + chevron to Layout when every moment is Auto (`wholeClipIsAuto`); quiet line "Speaker analysis is still running" / "Speaker analysis isn’t available for this clip"; left out for audio sources and clips under `SCENE_LAYOUT_MIN_DURATION_SEC`. Receipt checked; refusal toasts why. |
| Auto-censor (`censor-row.tsx`) | "2 words found" / "2 words found, 4 censored" / "No sensitive words found" + chevron to Censor; plan gem when applying is gated (`autoCensorApplyLock`, the panel's own rule). |
| Emphasize keywords (`emphasis-row.tsx`) | Chevron to Captions › Customize › Emphasis; left out when the style has no hero word (`captionPresetHasEmphasis`, which the Customize tab now also uses). |
| B-roll (`broll-row.tsx`) | "Add visuals over your clip" / "Cutaway added" + chevron to B-roll. |

Read-only (`rowControl`): Apply buttons and run errors are not shown; chevron rows stay clickable;
the sidebar's existing `ReadOnlyPanelNotice` explains.

### Moved to shared modules (both callers use them; behaviour of the old caller unchanged)

- `S/cleanup-cuts.ts`: `REMOVE_SILENCE_DEFAULTS`, `studioSilenceRanges`, `silenceCuts`, `fillerCuts`,
  `addedCutSec`. The timeline's `RemoveSilencePopover` reads its slider defaults and preview from
  it. Its "−X.Xs" figure now comes from `addedCutSec` (union with existing cuts); since
  `detectSilenceRanges` already subtracts existing cuts and normalizes, the number is the same.
- `S/tool-panels/auto-censor-scan.ts`: `useAutoCensorSuggestions`, `AUTO_CENSOR_PADDING_SEC`,
  `autoCensorApplyLock`. The Censor panel's inline scan and padding constant moved here unchanged
  (same inputs, same memo keys; `projectTerms` was `censorWords.project`).
- `S/tool-panels/layout-panel-model.ts`: `sceneLayoutEdits` (scene layouts + removal of manual
  speaker transforms over the range, as the Layout grid did inline) and `wholeClipIsAuto`. The
  Layout panel's `selectLayout` calls `sceneLayoutEdits` with the same arguments.
- `S/edit-refusal.ts`: `refusedEditToast(receipt)`.
- `S/studio-shell.tsx`: `applyRemoveSilence` → `applyDetectedCuts`, now checks the dispatch receipt
  and toasts the refusal (both callers).

### Opening a panel at a place (`S/tool-target.ts`)

`openTool(opening: ToolId | { tool: "captions"; section: "emojis" | "emphasis" })` on the shell sets
`activeTool` and `toolTarget`. `CaptionsPanel` reads the target once on mount (`useState`
initializer), opens Customize, clears it, then on the next frame `revealPanelSection` scrolls the
`data-panel-section` element to just below the sticky live preview (`data-panel-sticky`). Rail clicks
go through `openTool(id)`, so a stale target never survives.

### Emoji answers survive panel switches

`S/emoji/caption-emoji-run-host.tsx` (`CaptionEmojiRunHost`, mounted once in `ToolSidebar`, which
never unmounts) mounts an emoji editor only while the clip's run is saving or running, so the answer
always has a registered source to commit through, whatever panel is open. The AI tools panel also
mounts one editor (`useStudioCaptionEmojiEditor`) while open. Two mounted editors still commit once
(the run writes through the latest registered source, ticket 16).

### Rail

`ai` / "AI tools" / lucide `WandSparkles`, first. Nine items already overflowed the rail on short
screens (the old rule keyed on window height; at 900 px the rail is ~562 px tall and 9 compact items
needed 570). The rail is now a size container and compacts by its own height: ≤819 px labels at
58 px, ≤631 px labels at 48 px, ≤531 px icons at 36 px, ≤411 px icons at 30 px with 2 px gaps
(fits down to 330 px), shorter scrolls. Measured in the prototype with the Studio's budget (top bar
56, timeline 250, frame 8): all ten fit at 900 (48 px labels), 760 (36 px icons) and 680 (30 px
icons). With the timeline hidden the rail is ~198 px taller and gets the roomier tiers.

### Fixed in the second pass

- Rail compact rules (above); the rail comment said nine tools.
- Rail clicks cleared no stale target (`openTool(id)` now).
- The emoji row's "Try again" could replace hand-edited emojis without the section's Regenerate
  confirmation; retry is offered only while the clip has no emojis.
- The reframe note was two lines; now one.
- The running spinner was nearly invisible on the button surface (`sm`, `studio.fg`).

### Tests (all new)

- `tool-panels/ai-tools/ai-tools-model.test.ts` (22): silence row (counts from the popover's defaults,
  already cut, measured quiet audio, singular), filler row (English, `en-GB`, Urdu/German/null left
  out, already cut, none found), reframe "already on" (new clip, scene/background/framing/other ratio,
  Apply in one edit drops scene choices and speaker moves, gaps), emoji row views, censor counts,
  row order and read-only control.
- `tool-panels/ai-tools-panel.test.tsx` (14, static markup with a mocked shell over
  `ai-tools-fixture.ts`): rows and order for a fresh clip, the plan gem, applied states, rows left out
  (Urdu audio classic), no caption words, read-only, the emoji row idle / saving / running / done /
  empty / failed / failed Regenerate / read-only, and every `ToolId` has one `TOOLS` entry and a
  `PANEL_MAP` panel with AI tools first.
- `tool-target.test.ts` (6): opening resolution, Captions tab choice, reveal geometry under the sticky
  preview, no-op without the section.
- `edit-refusal.test.ts` (1).

### Prototype and screenshots

`http://localhost:3000/prototype/ai-tools` (dev only; `?only=fresh,running,failed,applied,empty,urdu,readonly`,
`?view=rail` for the real rail and panel inside the Studio's height budget). Shared fixture:
`S/tool-panels/ai-tools/ai-tools-fixture.ts`. Screenshots in
`/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/ai-tools/`:
`states-1.png` (fresh, running, failed, applied), `states-2.png` (empty, Urdu audio, read-only),
`running.png`, `rail-900.png`, `rail-760.png`, `rail-680.png`.

Compared with the Vizard reference: same structure (header, icon above a medium title, one muted
line, Apply down the right edge, chevrons for panel rows, ~90 px rhythm vs Vizard's ~100). Different
on purpose: no divider lines (spacing only), soft filled Apply instead of outlined, graphite; the
running row keeps the list usable (no blocking modal); a done row shows its state ("12 emojis",
"On") instead of a fresh Apply.

### Behaviour changes the owner will notice

- A new first rail item, AI tools, with the seven rows above.
- The rail compacts by its own height, so all ten items show on short screens (before, the last one
  was cut at 900 px and below).
- Remove silence in the timeline: if the session refuses the edit (read-only, conflict, loading), a
  toast says why and the popover stays open; before, it closed as if it had worked.
- Rows open Captions on Customize scrolled to Emojis or Emphasis.
- An emoji run started anywhere commits even when every panel is closed.

### Commands

- `bun run typecheck`: 17 of 17 successful.
- `bun run --cwd apps/web test`: 1,449 pass, 0 fail (43 new). An earlier run showed 3 failures and
  2 ENOENT errors in ticket 22's transcript files (their debug files mid-edit); gone on re-run.
- `bun run check:web-split`: passed.
- `bunx biome check` on every file touched (incl. shared `captions-panel.tsx`,
  `captions-panel-model.ts`, `studio-shell.tsx`): clean.

### Not covered

- No signed-in Studio was opened; the Captions target reveal is covered by unit tests and code
  reading, not a browser run. The prototype's rail view toggles only the AI tools panel.
