# Music lane on the Studio timeline

Owner request (2026-11-20): give the music track full control on the timeline, starting with drag to move. It should feel more professional than Vizard's.

## Vizard behaviour, observed live on 2026-11-20 (owner's session, editor id 168246773)

- **Lane:** the music lane sits under the source waveform. Each **audio block** shows a music-note icon, the title, and the track's waveform clipped to the block. The waveform is drawn at the full track length and offset by the in-point.
- **Click:** a click selects the block (purple border, edge grips, and a duration badge such as `38.1s` at the right end) and moves the playhead to the click point. Clicking empty lane space seeks and deselects.
- **Drag body:** while dragging, a ghost copy follows the cursor and the original is hidden. On drop the block keeps its length. Two problems:
  - Dropping past the clip end silently cuts off the block's tail. That is destructive.
  - Dropping onto another block silently snaps back to the old position.
- **Trim edges:** each end has a grip about 6px wide. A left trim moves the in-point (the waveform offset changes) and shows a time tooltip (`00:12.52`) above the edge. A right trim shortens the block. A left trim can be extended back until the in-point reaches 0.
- **Right-click:** opens a context menu at the cursor and also seeks. The menu has:
  - Volume slider, 0–200%, default 50%
  - Fade in, 0–5s
  - Fade out, 0–5s
  - Split (S), which splits at the playhead
  - Delete (⌫)
  The menu is only reachable by right-click, so it is hard to discover.
- **Split:** creates two independent blocks, each with its own in-point.
- **Add from the library:** hovering a row shows Favourite and **+**. Adding inserts a block at the playhead that runs to the clip end. If it would overlap an existing block, it goes on a second music row.
- **Autosave:** Vizard autosaves editor changes. A reload does not discard them.

## Narriflow design

### Model: Music Blocks

`studioEdits.music = { blocks: StudioMusicBlock[], ducking: boolean }` (see `packages/validators/src/studio-edits.ts`).

Each block has these fields:

| Field | Meaning |
| --- | --- |
| `id` | Block id |
| `assetId` / `url` | Asset or pasted link; one is required, and `assetId` wins |
| `title` | Display-only cache |
| `startSec` | Start on the edited timeline, in seconds |
| `endSec` | End on the edited timeline; `null` means the clip end |
| `sourceStartSec` | In-point inside the track; the track loops past its end |
| `volume` | 0–100, default 35 |
| `fadeInSec`, `fadeOutSec` | 0–5 each |

Rules:
- Blocks are stored in timeline order and never overlap. Only the last block may have `endSec: null`.
- There is one music lane. No second rows: one lane with fades covers shorts.
- `ducking` is clip-wide.
- This replaces the old single bed (`url/title/volume/startOffsetSec/fades/assetId`). Per the pre-production policy there are no legacy parsers: old `music` objects lose their bed when parsed. Reset local data if needed.

Time space: blocks use edited-timeline seconds, exactly like text layers and SFX. The plan uses them directly. The Studio timeline converts with `baseEditedToComposite` and `compositeToBaseEdited`, the same as `TextLayerChip`.

### Plan (`packages/composition-plan`)

- `assets.music` becomes `Record<blockId, CompositionAssetAvailability>`, keyed like `soundEffects`.
- `CompositionAudioSchedule.music` becomes an array, one entry per playable block. The type is already written in `clip-composition-plan.ts`:
  - `activeRange = [startSec, min(endSec ?? editedDuration, editedDuration)]`. Skip the block when the range is empty.
  - `fades` are absolute plan ranges inside `activeRange`. They are computed with `resolveMusicFadeWindows(fadeIn, fadeOut, blockDuration)` and offset by the block start.
  - Ducking windows are clip-wide and shared by every entry.
  - `gain = volume/100`.
- `music_asset_pending` and `music_asset_unavailable` notices are raised per block.

### Render (`apps/media`)

- Each block gets its own `-stream_loop -1 -i <file>` input. Downloads are deduped by asset id or URL.
- Each block's filter branch:
  `[i:a]atrim=start=<sourceStart>:duration=<blockDur>,asetpts=PTS-STARTPTS,volume=<g>,<block-relative afade in/out>,adelay=<startMs>:all=1,apad,atrim=duration=<clipDur>,<ducking volume expr in clip time>[music<k>a]`
  Ducking goes after `adelay` so its `t` is clip time. User fades go before the delay, so their `st` is block-relative.
- A failed music download is logged and skipped per block. It never fails the clip, as today.
- `render-input-snapshot` collects every block's `assetId`. `clip-editor-document-codec` checks every block `url` with `assertPublicHttpUrl`. Brand music seeding writes one full-length block: `{startSec:0,endSec:null,sourceStartSec:0}`.

### Studio UI (`apps/web` studio `_components`)

**Lane**
- A Music lane goes under the waveform, with a rail icon.
- It is always shown when blocks exist. With no blocks, show a slim empty lane: "Add music" opens the Audio tool.

**Block**
- Shows the note icon, the title, and a duration badge while selected.
- Shows the track waveform when peaks can be decoded. This is best effort: fetch plus `decodeAudioData`, cached per URL. If decoding fails, show a flat fill.
- Shows fade ramps drawn on the block.
- Has edge grips 8px wide.

**Selection**
- Click selects the block and seeks to the click point.
- Selection joins the single-selection invariant with caption, text layer and segment.
- Selecting a block sets `activeTool` to the music tool. The sidebar then edits that block.
- Escape deselects.

**Move**
- Pointer-capture drag that keeps the block's length.
- On drop, the block **clamps** to the clip bounds and its neighbours. It never truncates and never snaps back.
- With snapping on (`N`), the block's edges snap to the playhead, 0, the clip end and neighbour edges, and a guide line shows the snap.
- A live time tooltip shows the start time.
- The whole gesture is one undo step, using a coalesce key per block and `endCoalesce`.

**Trim**
- A left trim moves `startSec` and `sourceStartSec` together, clamped at in-point 0 and at the previous neighbour.
- A right trim moves `endSec`, clamped at the next neighbour or the clip end. Dragging to the clip end stores `endSec: null`.
- The minimum length is `MUSIC_BLOCK_MIN_DURATION_SEC`.
- A tooltip shows the edge time.

**Context popover**
- Opens on right-click, or on double-click of a block.
- Contains Volume 0–100, Fade in 0–5s, Fade out 0–5s, Split (S) and Delete (⌫).
- Sliders coalesce and call `endCoalesce` on change end.

**Keyboard**
- With a block selected, Delete or Backspace removes it.
- `S`, `D` or Ctrl+B splits the selected block at the playhead when the playhead is strictly inside it, at least the minimum length from both edges. Otherwise it falls through to the existing segment split.

**Music tool panel**
- The library's "Use" adds a track:
  - With no blocks, it adds a full-length bed from 0.
  - When the playhead is inside a block, it replaces that block's track: the timing is kept, `sourceStartSec` resets to 0, and the title, asset and url change.
  - Otherwise it inserts at the playhead and runs to the next block or the clip end. When there is less than the minimum gap, it says so.
- Volume and fade controls bind to the selected block, or to the only block when exactly one exists.
- The ducking toggle stays clip-wide.
- The old Start slider is gone; the left trim replaces it.

**Preview**
- One hidden `<audio loop>` per playable block, keyed by block id, driven by the per-block planned state from `composition-preview-adapter.ts`.
- `timelineTimeSec = (sourceStartSec + (t - activeRange.startSec)) % sourceDurationSec`.

### Rebase

`rebaseStudioEdits` maps each block's `startSec` and `endSec` (when not null) through edited → source → edited, like `rebaseTextLayers`.
- A block whose range collapses below the minimum is dropped.
- A block that would overlap the previous one after rebasing is clamped to start at the previous block's end. If too little is left, it is dropped.
- `sourceStartSec` does not change.
