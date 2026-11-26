# 19 - Scene Styles build at different frame rates in the Studio and the export

**What to build:** Find out why a Scene Style can lay out differently in the export than in the
Studio when the render is not 30 fps, and make the two build the same scene. Found by the Sol
re-check on 2026-11-26. Rules: [../RULES.md](../RULES.md).

**Blocked by:** [17](17-captions-in-inserted-scenes.md)

**Status:** done

## The report

With Trail at 540x960, words starting at 0.31 s every 120 ms and a flame on `believe`, the shared
placement code puts the flame below at 24, 25 and 30 fps and above at 50 and 60 fps, a move of
402 px. The measurer was held constant and the ASS confirms it. The cause is not the emoji layer's
fixed 30 fps collision grid (ticket 14): the Scene itself is built with different geometry at
different rates, before placement. `apps/media/src/caption-scene-ass.ts` (about line 186) passes
the render's frame rate into the scene input; the Studio's painter passes none, so programs plan
for `SCENE_DEFAULT_FPS`. `SceneInput.fps` exists "for programs that plan by painted frames
(`frame-grid.ts`)".

## Part 1: what is going on

- Which programs read `input.fps` (or `ctx.fps`, `frame-grid.ts`), and what they decide from it:
  timing only (snapping windows to painted frames), or layout too? How large are the differences
  in the built scene between 24, 25, 30, 50 and 60 fps for the same cues: list the styles whose
  pieces differ in position or size (not only in window edges), with the largest difference.
- Does this predate the emoji work? (`git show refs/emoji-baseline:<path>` to read old code.) It
  almost certainly does: say so with evidence.
- What frame rate does an export actually use (the source's rate, a fixed rate, a capped rate)?
  Where is it decided (`apps/media`, the composition plan, the render attempt)? What does the
  Studio know about the clip's source: is the source frame rate anywhere in the data the Studio
  already loads (project or clip media info, the preview proxy, the editor document, the plan's
  inputs)?

## Part 2: make both sides build the same scene

Choose the smallest correct design and say why:

- If the export's frame rate is knowable in the Studio from data it already has, pass it into the
  scene build input on the Studio side (it is already part of `sceneBuildKey`) so both build the
  same scene, and let the emoji layer use the same rate for its grid (ticket 14 fixed it at 30
  only because the rate was unknown; with a known rate, one rate for the scene build, the emoji
  grid and the ASS sampling is the honest design).
- If it is not knowable without a new API field, add the field where the Studio already reads the
  clip's media facts (validators schema, the service that returns it, the api-client type); a
  frame rate is a fact about the source, not a setting. Keep the change small and read-only.
- If programs only need the rate to snap timing, and layout differences come from a program using
  the rate where it should not, fix the program contract instead (layout must not depend on the
  frame rate) and say which programs changed. Template program files may be edited for this, but
  a 30 fps build must stay byte-identical for every style (prove it with the demo scenes).

Then prove it: for Trail, Lyrics, Horizon, Flap and three other styles that read the rate, the
Studio's scene input and the worker's scene input are equal for a 24, 25, 30, 50 and 60 fps clip;
the reproduction above places the flame on the same side on both renderers at every rate; ticket
12's parity check still passes; the placement and conformance suites pass.

## Acceptance

- [x] Part 1's findings recorded (which styles, how much, since when, what rate exports use).
- [x] Part 2 implemented with tests, or a clear statement of why it cannot be done without a
      larger change, with the recommended change.
- [x] `bun run typecheck`, `bun run test`, `bun run --cwd apps/api openapi:check` and
      `test:inventory` if an API shape changed, `bun run check:web-split`, biome on touched files.

## Evidence

Done 2026-11-26. Nothing committed, migrated or deployed.

### Part 1: findings

**Which programs read the rate.** 41 template files under `packages/caption-scene/src/templates` read `input.fps` (directly,
through a `ctx.fps`, or through `frame-grid.ts`). They decide timing *and* layout from it: whether an entrance or exit gets
enough painted frames (`paintedFrameCount(...) >= 2/3/4`), which pieces are dropped for painting on fewer than two frames,
and collision checks done on export frames. Trail is the clearest layout case: `handoffs` and its three refinement rounds
check, on every export frame (`grid.times`), whether the next cue's ink meets this one, and move or re-pace the cue when it
does; a different grid sees different collisions and chooses a different control. So "layout must not depend on the rate"
would change the programs' own contract (their guarantees are about painted frames), and a 30 fps build could not stay the
same. Not chosen.

**How much.** Script `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/85f7adad-9a4c-4372-ac1c-722c46b29e96/scratchpad/fps/part1.ts` (output `part1.tsv`
beside it): every one of the 84 styles, its demo at 1080x1920 and fast speech (120 ms words, the reviewer's cues) at
540x960, built with the worker's HarfBuzz measurer at 24, 25, 50 and 60 fps against 30. Per piece id: pieces added or removed,
window-edge shift, and the *smallest* box difference over every 10 ms the piece is live in both builds (above 0 means the
piece is never in the same place at the same moment, so it is not only an edge). 31 styles differ on each cue set; in 21 of
them only window edges or sub-pixel noise (≤ 0.5 px). Position or size differences:

| Style | Largest (px) | Where |
| --- | --- | --- |
| Vibes | 416.7 (demo, 24 fps) | `dots2`; sweeps 40 to 88 px at 25/50/60 |
| Trail | 386.4 (demo, 24 fps) | word `t2` (a cue moved); 91 to 112 px at 25/50/60; 28 px on fast cues |
| Glint | 156.5 (fast, 24/25 fps) | hero highlight `w3h`; 93 px at 50/60 |
| Ripple | 102.2 (demo, 50/60 fps) | ring `ring0-2`; 25.6 px on fast cues at 24/25 |
| Horizon | 56.4 (demo, 50/60 fps) | scan line `scan0` |
| Cascade | 18.1 (fast) | `scan3` |
| Funky | 14.0 (fast) | confetti `conf3` |
| Ledge | 12.4 (fast) | `pc1d` |
| Blinds | 8.7 (fast) | slats; also 10 to 25 pieces added/removed at 24/50/60 |
| Rainbow | 7.9 (fast, 24 fps) | `accent1` |

The other 21 differing styles differ in window edges or by 0.5 px or less. Flap and Lyrics build the same scene at every rate on both cue sets. Building with `fps: 30` gives the same JSON as building
with no rate for all 84 styles on both cue sets (`30=unset` on every row).

**Since when.** It predates the emoji work. `refs/emoji-baseline` (0e425898f): `SceneInput.fps` exists ("Unknown in the Studio
preview"), `caption-scene-ass.ts` passes `fps` into `sceneInputFromPreset` (line 186), the Studio painter passes none
(lines 101, 136), `sceneBuildKey` has no rate. The shared frame grid came in 9b6dcfb36 (2026-11-22, "share the export frame
grid with scene programs"); the render has passed `captionFps` since 16310989f (2026-11-20).

**What rate an export uses.** The source's own clock, not a fixed or capped rate: `renderOutputFrameRate(probe)`
(`apps/media/src/composition-ffmpeg-adapter.ts`) = `videoClock.constantRate` (only for a source the worker normalizes) ??
`facts.videos[0].rFrameRate` ?? `standardFrameRate(fps)` ?? 30/1. `clip-render-attempt.ts` (about line 3739) turns it into
`captionFps` for captions; the encoder and the output validator use the same value; the preview proxy too
(`clipPreviewOutputExpectation`). The scene writer samples at `sceneSampleRate` (capped at 60), programs see the raw rate.
`videoClock` comes from `decideVideoClock` at probe time: when the base and average header rates disagree by more than 1%
it reads up to 300 packet timestamps and normalizes a variable stream to `chooseConstantFrameRate(average)`; a base rate
over 240 is always normalized.

**What the Studio knew.** Nothing: no API-client shape, the plan or the editor document carries a rate. But the fact is
stored: `Project.sourceProbe` holds the ingest probe, including `facts.videos[0].rFrameRate` and `avgFrameRate` (prepare
checks a fresh probe against it byte for byte). Only the packet-timestamp evidence is not stored.

### Part 2: design

Pass the export's rate to the Studio, computed from the stored probe by one shared function; the Studio puts it into the
scene build input (and so `sceneBuildKey`) and the emoji layer's grid. No column, no migration.

- `renderFrameRate(probe)` in `packages/validators/src/source-probe.ts`: `renderOutputFrameRate` without the packet read.
  `chooseConstantFrameRate` and the two clock thresholds moved there from `worker-process.ts` (which imports them now), so
  the normalization rule has one implementation.
- `ProjectSnapshot.renderFrameRate` (services), bootstrap `clipInfo.renderFrameRate` (API), `ClipInfo.renderFrameRate`
  (Studio; the api-client type is inferred from the route).
- `sceneBuildKey` includes `input.fps ?? null`. The Studio's `CaptionSceneBuildInput.fps` goes to `sceneInputFromPreset` in
  `buildScene` and `captionSceneInputKey`; `InteractiveSceneOverlay` sets it from `clipInfo`.
- Emoji layer: `CAPTION_EMOJI_PLACEMENT_FPS` removed; `CaptionEmojiLayerInput.fps?` (default `SCENE_DEFAULT_FPS`, grid via
  `sceneSampleRate`) and in `captionEmojiLayerKey`. Worker passes the render rate (`captionEmojiEvents`); Studio passes it
  through `CaptionEmojiLayer`'s `fps` prop (Scene path from the built input, classic and Dynamic from the overlay's `clipInfo`).
  One rate for scene build, placement grid and ASS sampling.

Why not the alternatives: a fixed 30 fps grid for scenes would change every program's painted-frame guarantees at other
rates (and Trail's collision avoidance would be checked on frames the export does not paint); a new stored field is not
needed because the facts are stored.

What the Studio shows until the rate is known: nothing new to decide. `clipInfo` comes from the Studio bootstrap, which is
loaded before `StudioShell` mounts (the page shows `StudioLoading` until the seed exists) and is never refetched, so the
rate is fixed for the clip and never flickers. It is derived from stored facts, not from media metadata.

Performance: for a clip at 30 fps the key gains one constant element and the build is the same scene (proved below), so it
rebuilds exactly as often as before. For any clip the rate is one number per clip; memo deps compare it by value.

Limit (stated in `renderFrameRate`'s doc and ADR 0021): a source whose header rates disagree by more than 1% with a base rate
of 240 or less, *and* whose packets the render finds variable, renders at the normalized average while the Studio plans at
the base rate. Interlaced footage (59.94 field rate over a 29.97 average, regular packets) is not affected: both use the base.
Closing it needs the clock decision stored at ingest (for example `sourceProbe.video.renderFrameRate` set from the ingest's
`videoClock`, with prepare's byte-for-byte probe check excluding it and the render reading it instead of deciding again):
a render-pipeline change, not made here.

### Proof

- Studio input equals worker input: `apps/media/src/caption-scene-frame-rate.test.ts` (new). For Trail, Lyrics, Horizon,
  Flap, Vibes, Glint and Cascade, on 120 ms and 400 ms words, at 24, 25, 30, 50 and 60 fps: the input the Studio's painter
  builds equals `sceneInputForLayers`' (deep equal less the measurer), `fps` is set, keys are equal, built scenes are equal
  JSON. The web test (`caption-scene-painter.test.ts`) pins that `captionSceneInputKey({ ...input, fps })` is
  `sceneBuildKey(sceneInputFromPreset(..., fps))` and that every rate gives its own key.
- 30 fps unchanged: `part1.tsv` shows fps 30 and no rate build the same JSON for all 84 styles on both cue sets; tested again
  for Trail (media) and Lyrics (web). No template program changed.
- Reproduction (Trail, 540x960, flame on `believe`), Studio path (painter input, `captionSceneEmojiCueBoxes`,
  `placeCaptionEmojis`) against the export's `\pos`:

| fps | export | Studio before | Studio now |
| --- | --- | --- | --- |
| 24 | 269.81,815.23 | below 269.73,846.55 | below 269.81,815.23 |
| 25 | 270.01,848.41 | below 269.73,846.55 | below 270.01,848.41 |
| 30 | 269.73,846.55 | below 269.73,846.55 | below 269.73,846.55 |
| 50 | 270.93,444.51 | below 269.73,846.55 | above 270.93,444.51 |
| 60 | 270.24,444.51 | below 269.73,846.55 | above 270.24,444.51 |

  Equal at every rate (test "Trail's flame..."). The flame still changes side with the rate, on both renderers alike: Trail
  lays the cue out differently at 50/60 fps; that is the program's frame-based layout, the same in the preview and the export.
- Emoji grid: `caption-emoji-ass.test.ts` "on the render's frame grid": an 8 ms obstacle on a 60 fps frame and between frames
  of 24/25/30/50 moves the emoji below at 60 fps only, and the shared builder at the same rate (the Studio's) gives the
  export's pivot at all five rates. Replaces ticket 14's fixed-grid test.
- Render rate: `composition-vfr.test.ts` runs the real `inspectMedia` over 16 header/packet cases (CFR, NTSC, interlaced,
  regular disagreeing, unreadable packets, 90000/1 and 1000/1 bases, no average) and checks
  `renderFrameRate(inspection.sourceProbe)` equals `renderOutputFrameRate(inspection)`; and shows the one differing case
  (60/1 base, 30/1 average, irregular packets: render 30, Studio 60). `source-probe.test.ts` covers the function alone.
- Ticket 12 parity (its scripts, copied to `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/85f7adad-9a4c-4372-ac1c-722c46b29e96/scratchpad/fps/parity/`, headless Chrome on
  `next dev` port 3100 against `renderCaptionTrack`): classic, Dynamic and Scene, LTR and RTL, every emoji 0.00 px in centre,
  size and tilt; Bubble-rtl its known Nastaliq measurement difference (up to 28.27 px); windows within one frame (0 to 30 ms).
  The prototype passes no rate, so this is the 30 fps case. I started that server (none was running) and stopped it after.

### Verification

- `bun run typecheck`: 17/17 successful.
- Tests: `caption-scene` 3132 pass (conformance and placement included); `validators` 1352; `composition-plan` 198;
  `apps/api` 994; `api-client` 234; `apps/web` 1363; `apps/media` 1201 pass, 1 skip; `services` 1696 pass, 1567 skip (DB). 0 fail.
- `bun run --cwd apps/api test:inventory`: 302 routes, 0 problems. `openapi:check`: matches all 32 REST operations (the field
  is first-party only). `bun run check:web-split`: passed. `bun run --cwd apps/api build:worker`: audit passed.
- `bunx biome check` on the 23 touched code files: clean.
