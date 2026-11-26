# 17 - Scene Style captions keep drawing into an inserted scene

**What to build:** Decide whether this is a real defect, and if it is, fix it for every Scene Style
without editing template programs. Asked for by the owner on 2026-11-26 ("Fix this as well if it
is a real issue"). Rules: [../RULES.md](../RULES.md).

**Blocked by:** [15](15-sol-backend-fixes.md)

**Status:** done

## The report

From ticket 15's Evidence ("Found, not mine"): with a scene inserted into a clip, Scene Style
captions keep drawing into the inserted scene. Reveal draws for its 650 ms tail
(`SCENE_CUE_TAIL_MS` in `packages/caption-scene/src/cues.ts`); Lyrics keeps its neighbouring lines
up. It happens even when the scene sits between two cues, and it predates the emoji work.

## Part 1: is it real?

Establish the intended behaviour from the code and docs before changing anything:

- What an inserted scene is (`sceneBlocks` in the editor document, `GLOSSARY.md`, the Studio's
  scenes panel, how the composition plan places them on the output timeline) and what plays during
  one (picture, audio, speech).
- What the plan intends for captions around one: it slices caption layers around inserted scenes
  (`clip-composition-plan.ts`, the `scene-slice` code ticket 15 rebuilt) and gives each slice an
  `activeRange`. What do classic presets and Dynamic Styles draw during the inserted scene, in the
  Studio and in the export? What do subtitle files contain?
- What Scene Styles draw during it, in both renderers: reproduce with Reveal, Lyrics, Horizon and
  Dialogue, with the scene between two cues and inside a cue, through `buildCaptionScene` and the
  worker's caption build. Save one frame per case from a real render (the recipe is in ticket 06's
  and ticket 15's Evidence and in `apps/media/src/caption-inserted-scene.test.ts`).

It is a real defect if captions are meant not to show during an inserted scene and Scene Styles
show them there. If classic and Dynamic also show captions during the scene, or the docs say
captions carry over, report that and stop: say what the product does and what you would recommend,
and change nothing.

## Part 2: the fix (only if real)

- One rule for every Scene Style, applied to the built scene, not inside template programs: no
  caption piece paints inside an inserted scene's window on the output timeline. A piece whose
  window crosses an inserted scene is cut at the scene's start (and, if it continues after the
  scene, resumes at the scene's end; a piece's track is absolute-time keyframes, so a piece cut in
  two evaluates the same on both sides). Prefer the smallest correct design: for example the plan
  exposes the target's inserted-scene windows, the Scene input carries them (and `sceneBuildKey`
  includes them), and `buildCaptionScene` applies the cut after the program runs. Choose after
  reading the code; say what you chose and why.
- Lyrics and other styles that keep neighbour cues on screen: the same cut covers them. Check what
  it looks like when a stack is cut and resumes, and whether the cue after the scene should enter
  fresh; keep it simple and say what you chose.
- The emoji layer derives its cue boxes and windows from the built scene's pieces
  (`sceneCueBoxes`), so it must follow automatically: confirm an emoji never paints inside an
  inserted scene, on all three caption kinds.
- Both renderers get the same scene: the Studio (`useCaptionScene`, `interactive-scene-overlay.tsx`,
  `scene-caption-emojis.tsx`) and the worker (`renderCaptionScene` in `caption-ass.ts`). No
  per-renderer logic.
- A clip with no inserted scene must build byte-identical scenes and ASS (prove it on several
  styles).
- Tests: the cut on a between-cues scene and an inside-a-cue scene for Reveal, Lyrics, Horizon and
  Dialogue; the ASS has no caption or emoji event overlapping the scene window; the Studio's scene
  input carries the same windows as the worker's; unchanged output without inserted scenes; the
  conformance and placement suites still pass.
- Real renders before and after for Reveal and Lyrics, frames inside the inserted scene, saved to
  `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/inserted-scene/`.
  Look at them.

## Acceptance

- [x] Part 1's finding recorded with evidence.
- [x] If real: Part 2 done; `bun run typecheck`, `bun run test`, biome on touched files; the parity
      check from ticket 12 still passes on Scene presets.

## Evidence

Done 2026-11-26. Nothing committed, migrated or deployed.

### Part 1: real defect

What an inserted scene is: a Scene Block occupies its own composition time. The plan gives it a scene of its own
(`addInsertedSceneBlocks`, `sourceRange: null`, layer z 25), and every source range after it moves later. While it plays
the clip's own picture and speech stop: the FFmpeg adapter gives that span silence (`anullsrc`), or the inserted
video's own audio when it is not muted (`composition-ffmpeg-adapter.ts`, around line 360). Captions burn after the concat
over the whole timeline at z 40, so any caption event inside the span draws over the scene. In the Studio,
`InteractiveSceneOverlay` stays mounted and paints from the playback clock, also over the scene.

What the product intends: captions stop during an inserted scene. The plan slices each caption layer at the scene
(`retimeVisualLayersForInsertedScenes`, `captionCueSlice`) and no slice's `activeRange` reaches into it. Subtitles use
the same slices (`deriveCaptionCues`). Nothing in the docs says captions carry over a scene (ADR 0004 only says
inserted blocks interrupt B-roll's visible ranges).

Reproduction: 12 words every 0.4 s from 0.2 s, 4 per cue, 540x960, a 2 s scene at 1.7 s (inside a cue) or 1.8 s
(between cues), flame on 1.0 s and rocket on 1.4 s. Worker caption build (`compileCompositionPlanCaptions`, 30 fps),
events overlapping the scene:

| Preset | Inside a cue: captions / emoji events | Between cues: captions / emoji events |
| --- | --- | --- |
| Electric (classic) | 0 / 0 | 0 / 0 |
| Headline (Dynamic) | 0 / 0 | 0 / 0 |
| Reveal | 54 / 6 | 54 / 6 |
| Lyrics | 218 / 6 | 289 / 0 (its emoji was dropped `no-room`, crowded by the stack painting into the scene) |
| Horizon | 96 / 6 | 94 / 6 |
| Dialogue | 123 / 6 | 129 / 6 |

Subtitles: `0.20-1.70 | 3.70-3.75 | 3.80-5.35 | 5.40-6.95` (inside) and `0.20-1.75 | 3.80-5.35 | 5.40-6.95` (between).
None overlaps the scene.

What the shared build painted inside the scene (`buildCaptionScene`, both renderers build the same scene): Reveal and
Horizon paint the cue's 650 ms tail (cue 0's `endMs` is 2350 or 2400) and the next cue's 80 ms entrance (3620-3700).
Lyrics paints for the whole scene: dim neighbour lines and its "•••" pause marker. Dialogue paints for the whole scene too.

Real frames (production plan and FFmpeg command, the "before" ASS is the caption build without the ranges, which is the
old call path; scene colour #1E3A5F). Each sheet: top row before, bottom row after, frames at scene start -0.2 s, +0.3 s,
+1.9 s and +2.2 s:
- `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/inserted-scene/sheet-reveal-at1.7.png`: before, cue 0 and its rocket sit on the scene at +0.3 s; after, the scene is clear.
- `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/inserted-scene/sheet-lyrics-at1.7.png`: before, the dimmed stack and "•••" are on the scene at +0.3 s and +1.9 s; after, clear.
- `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/inserted-scene/sheet-reveal-at1.8.png`, `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/inserted-scene/sheet-lyrics-at1.8.png`: the same with the scene between cues; before, Lyrics' rocket
  stays on the scene for its whole length.
Single frames: `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/inserted-scene/<preset>-at<anchor>-<before|after>-t<seconds>.png`, plus each MP4 and ASS.

### Part 2: the fix

Design: the plan already holds each target's inserted scenes (its `inserted-scene` scenes), so it exposes them and
both renderers pass them into the one scene input.
- `packages/composition-plan`: `insertedSceneRanges(target)`, the target's inserted scenes in composition seconds.
- `packages/caption-scene`: `SceneInput.insertedScenes?: SceneWindow[]` (ms). `sceneInputFromPreset` takes the plan's
  ranges and sets the field only when there is at least one. `sceneBuildKey` appends them only when present.
  `buildCaptionScene` runs the program unchanged, then `cutAtInsertedScenes` (new `inserted-scenes.ts`) cuts the pieces.
  No template program file changed. A cut piece keeps its window outside the scene. When it runs on past the scene, it
  resumes with id `<id>#n`, in the same place in the array, so paint order holds and the cue segment is unchanged. The
  scene records `insertedScenes` so the emoji layer reads them from the built scene.
- Emoji layer: piece windows were not enough. A stack (Lyrics, Dialogue) keeps a cue's pieces on screen after the scene,
  so its cue span would cross the scene. `sceneCueBoxes` cuts each cue's span to the side of the scene the cue is spoken
  on (`cue.startMs`; the plan never starts a cue inside a scene). Without that, the new test fails on Lyrics and Dialogue.
  Classic and Dynamic needed nothing: their boxes come from the sliced `activeRange`.
- Worker: `compileCompositionPlanCaptions` passes `insertedSceneRanges(target)` through `renderCaptionTrack` and
  `renderCaptionScene` into `sceneInputForLayers`.
- Studio: `video-preview.tsx` takes the same ranges from the same target (a constant empty array when none) and passes
  them to `InteractiveSceneOverlay`, which puts them in `CaptionSceneBuildInput`. `buildScene` and `captionSceneInputKey`
  hand them to `sceneInputFromPreset`. `SceneCaptionEmojis` reads them from the built scene.

Lyrics after the scene: the cut pieces resume, so after the scene Lyrics shows its normal stack (the previous line dimmed
above the current one). The after frames at +2.2 s match the before frames exactly. A fresh entry would make Lyrics
look different after a scene than after any other pause, and it would need per-cue logic in the cut, so I kept resume.

Performance: the cut is O(pieces × scenes): 0.26 ms for Wordform's 5640 pieces and 0.12 ms for Lyrics' 1560, with 10
scenes. For a clip without inserted scenes the key and input are unchanged. The overlay's memo gets a constant empty
array, so the scene rebuilds exactly as often as before. With scenes, the ranges change only when the plan changes,
which also replaces the layers, and the key decides whether to rebuild.

Unchanged without inserted scenes: `sceneInputFromPreset` with `[]` equals the input without it (no field). The build
returns the program's own scene object and the key is equal (test). The worker ASS from `compileCompositionPlanCaptions`
equals `renderCaptionTrack` called without ranges, byte for byte, on Electric, Headline, Reveal, Lyrics, Horizon and
Dialogue (test). The existing ASS snapshot and golden suites pass unchanged.

Tests:
- `packages/caption-scene/src/inserted-scenes.test.ts` (new, 12): the cut on hand pieces (cut, dropped, resumed `#n`,
  untouched pieces the same object). For Reveal, Lyrics, Horizon and Dialogue with a scene inside a cue and between cues:
  the uncut program paints into the scene and the cut scene does not. Ids are unique, each is the original or the
  original plus `#n`. At every 20 ms outside the scene the visible poses equal the uncut program's. `sceneCueBoxes`
  windows stay off the scene. An empty list changes nothing, and the key follows the ranges.
- `apps/media/src/caption-inserted-scene.test.ts`: now 6 presets × 2 positions. Captions on both sides, no caption or
  emoji event overlapping the scene (the Scene Style exception is removed), emoji on its word's side. Plus
  `insertedSceneRanges` on the plan, and the byte-identity test above.
- `caption-scene-painter.test.ts` (web): the Studio key ignores no or empty ranges and changes with ranges. It equals
  `sceneBuildKey` of the worker-equivalent input, with `insertedScenes` `[{ fromMs: 3200, toMs: 5200 }]`. A Lyrics scene
  cut at 3.5-6.5 s has unique ids and `#n` parts, every live piece is mounted around the scene, and nothing is live
  inside it.

Parity check from ticket 12 (copy of its scripts, headless Chrome on the running dev server versus `renderCaptionTrack`):
every Scene frame is 0.00 px off in centre, size and tilt. Bubble-rtl shows its known 28.27 px measurement difference.
Windows are within one frame, as before.

Docs: `GLOSSARY.md` (Scene Block: no caption draws over one) and ADR 0021's operating rules (one line).

### Verification

- `bun run typecheck`: 17/17 tasks successful.
- `bunx biome check` on the 16 touched code files: clean.
- `bun run test`: every package passed except `caption-scene`, which had 2 failures in `emoji/layer.test.ts` ("emoji timing").
  Another agent was editing `layer.ts` and `layer.test.ts` at 14:07-14:08. Re-run at 14:12: `caption-scene` 3132 pass,
  0 fail (conformance and placement suites included). `apps/web` 1362 pass, 0 fail. `apps/media` 1191 pass, 0 fail.
  `composition-plan` 198 pass.
