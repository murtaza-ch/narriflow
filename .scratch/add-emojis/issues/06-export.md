# 06 - Export: draw the emoji layer in the worker, delete the overlay chain

**What to build:** The export burns emojis in as ASS drawings for all three caption paths, and the
old sprite overlay and its diagnostics are gone. Rules: [../RULES.md](../RULES.md). Spec D3.

**Blocked by:** [04 - The emoji layer](04-emoji-layer.md)

**Status:** done

## Areas

`apps/media/**` (TypeScript and, for the diagnostics field, Python), and the `skippedEmoji`
plumbing in `packages/validators/src/clip.ts`, `packages/services/src/{render-group-lifecycle,clip.service}.ts`,
`apps/web/lib/caption-omissions.ts` and its tests. Clip render is a critical path.

## Deliverables

1. In `renderCaptionTrack` (`apps/media/src/caption-ass.ts`) and the scene writer: after the
   captions' events are built, produce the emoji layer once per caption target:
   - preload art for the plan's emoji ids (`loadCaptionEmojiArt`) before the synchronous build;
   - cue boxes: Scene Styles via `sceneCueBoxes` on the scene that was built; Dynamic Styles via
     `blockCueBox` from the block geometry already computed (`captionBlockGeometry`, about line
     383); classic via `lineCueBox` from `cueGeometry` (about lines 781-842); a Scene Style that
     threw (`caption_scene_failed`) uses the classic box;
   - `buildCaptionEmojiPieces` then `sceneEvents()` (`caption-scene-ass.ts`, about line 543) on a
     layer above the captions.
   Put this in its own module (`apps/media/src/caption-emoji-ass.ts`); `caption-ass.ts` calls it.
2. Delete the old path completely: `CaptionEmojiOverlay`, `placeEmoji`, the monochrome emoji event
   for plan emojis, `emoji` / `emojiSkipped` on the track (`caption-ass.ts` about 3-11, 139,
   194-238, 665-685, 847-893); `captionEmojiFilters` and every `captionEmoji` pass-through in
   `composition-ffmpeg-adapter.ts` (about 655-700, 715, 776-778 and the call sites);
   `clip-render-attempt.ts` (about 93, 659-660, 1123-1213, 3971, 4024, 4165);
   `SkippedEmoji` in `caption-glyphs.ts` where it only served plan emojis (keep everything that
   draws emoji typed in caption text with the monochrome fallback face, and `omittedCodePoints`);
   `captionEmojiSkipped` in `render-output-validation.ts`; `skippedEmoji` in the diagnostics shape
   and its readers named under Areas, including the Python side
   (`apps/media/python/narriflow_media/{artifacts,render_runtime}.py`) if it names the field.
   `composition-emoji.test.ts` goes or is rewritten for the new layer.
3. Golden fixtures: re-baseline the `emoji-sequences` case (`__fixtures__/render-golden/*`,
   `scripts/render-golden.ts`, `caption-frames.ts`) so it covers the new layer; keep the
   `known-defects.json` entry for emoji typed in text.
4. `apps/media/images/lean.dockerignore`: exclude `packages/caption-emoji/source` (the image needs
   the generated data only). Do not build the image. Note in Evidence that the image content
   changes, so the Worker's `MEDIA_*_TOOLCHAIN_FINGERPRINT` must be updated at deploy.
5. Tests: events for one emoji on a classic, a Dynamic and a Scene preset (ids, layer order above
   captions, shared `\org`/position across an emoji's layers during the pop); a cap test "ASS
   events per emoji is at most N" (state N from measurement); RTL cue; missing art skipped; a
   thrown scene falls back.
6. Real render: with the local FFmpeg and libass the repo's scripts already use
   (`apps/media/scripts/caption-scene-real-render.ts`, `caption-frames.ts`, the golden script),
   render short clips with emojis on one classic, one Dynamic and three Scene presets (include one
   RTL) and save frames to the scratchpad
   (`/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-export/`).
   Look at the frames yourself: outline closed, shadow under the outline, layers aligned during the
   pop, no seams, correct colours. Fix what is wrong. If no local libass build is available, say so
   and give the exact command that failed.
7. Budget: render time of a 60 s clip with 20 emojis against the same clip without (target under
   5% slower), and events per emoji.

## Acceptance

- [x] Deliverables 1 to 7.
- [x] `git grep -n -i "captionEmoji\|emojiSkipped\|skippedEmoji\|placeEmoji" apps/media packages/services packages/validators apps/web/lib` shows only the new layer's names.
- [x] `bun run lint`, `bun run typecheck`, `bun run --cwd apps/media test` (fast suites only), and
      the services and web tests touched by the diagnostics change.

## Evidence

Implemented 2026-11-26. Nothing committed, migrated or deployed.

### Files

- `apps/media/src/caption-emoji-ass.ts` (new): the worker's emoji layer. It preloads art
  (`loadPlanCaptionEmojiArt`) and has one cue-box helper per path (`classicEmojiCueBox`,
  `blockEmojiCueBox`, `sceneEmojiCueBoxes`). `captionEmojiStyle(preset)` and
  `captionEmojiEvents` (`placeCaptionEmojis`, then `sceneEvents`) return the events and a
  placed/dropped summary.
- `apps/media/src/caption-ass.ts`: each path pushes its cue boxes into the collector, but only
  when the target has emojis. `renderCaptionTrack` takes `emojiArt` and appends the layer's events.
  `CaptionTrack.emojis` replaces `emoji`/`emojiSkipped`. Deleted: `CaptionEmojiOverlay`,
  `placeEmoji`, the monochrome plan-emoji event and `LAYER.emoji`. The other layer numbers are
  unchanged, so a script without emojis is byte-identical (the classic preset ASS snapshots pass
  unchanged).
- `apps/media/src/caption-scene-ass.ts`: `renderCaptionScene` also returns the scene `input`
  (for `bodyPx` and the cues).
- `apps/media/src/composition-ffmpeg-adapter.ts`: deleted `captionEmojiFilters`, the atlas and
  motion imports, and every `captionEmoji` field and pass-through.
  `compileCompositionPlanCaptions` takes `emojiArt` as a 6th argument.
- `apps/media/src/tasks/clip-render-attempt.ts`: the art loads once per render, before the caption
  loop. A load failure logs `caption_emoji_art_unavailable` and the render continues with no emoji.
  `compileCaptionTrack` logs `caption_emojis_dropped` once per caption build, with counts by reason.
  Deleted: `captionEmoji` on the output, `emojiSkipped` in the warnings, the
  `caption_emoji_skipped` fallback code, and `skippedEmoji` in `captionDiagnosticsOf`.
- `apps/media/src/caption-glyphs.ts`: deleted `SkippedEmoji` and `monochromeEmojiFace` (used only
  by `placeEmoji`). The typed-emoji fallback face and `omittedCodePoints` stay.
- `apps/media/src/render-output-validation.ts` (+ test): deleted `captionEmojiSkipped`.
- `apps/media/src/composition-emoji.test.ts`: deleted. Replaced by
  `apps/media/src/caption-emoji-ass.test.ts` (10 tests).
- Test fixtures given `emojis: []` (the field is required and tests are not typechecked):
  `caption-ass`, `caption-word-order`, `caption-rtl-render`, `caption-studio-parity`,
  `caption-brand-font`, `caption-pill-render`. Removed from `caption-ass.test.ts`: the two old
  plan-emoji tests. `caption-glyphs.test.ts` no longer passes `skippedEmoji`.
- `apps/media/scripts/render-golden.ts`: preloads art. Cue summaries carry the layer's `emojis`
  instead of the per-word `emoji`. New measurements `captions.emojisPlaced` and
  `captions.emojisDropped` replace `captions.emojiSkipped`. The saturation probe samples each
  emoji's anchor + 300 ms.
- `apps/media/scripts/caption-scene-real-render.ts`: `--emojis N` and `--clip start,end` options
  (`withRealRenderEmojis`). The art is preloaded, and the timings record placed and dropped counts.
- Golden fixtures: `documents.json` `emoji-sequences` now carries `studioEdits.captionEmojis` (5
  entries). `expected/08-emoji-and-glyphs.json` contract: `captions.emojisPlaced` = 3, retain
  `crop` and `layer`, and the missing-glyph case asserts `captions.emojisDropped` = 0.
  `known-defects.json`: the emoji typed in text keeps its entry, with the predicate reworded.
- `apps/media/images/lean.dockerignore` and `render.dockerignore`: `packages/caption-emoji/source`
  excluded. The render image is the one that draws, so it gets the entry too.
- `apps/media/package.json` + `bun.lock` (one line): depends on `@narriflow/caption-emoji`.
- Diagnostics: `packages/validators/src/clip.ts`,
  `packages/services/src/{render-group-lifecycle,clip.service}.ts` (one line each),
  `clip-render-variant-snapshot.test.ts`, the services test fixture types
  (`render-execution-test-fixture.ts`, `render-group-test-fixture.ts`,
  `render-group-replicas.db.test.ts`), `apps/web/lib/caption-omissions.ts` (+ test),
  `apps/web/app/(app)/projects/[projectId]/caption-omission-note.test.tsx`, and the doc comment in
  `packages/db/prisma/schema.prisma` (no migration). The Python side passes `captionDiagnostics`
  through as opaque JSON and never names the field, so nothing changed there.

### Stored diagnostics stay readable

`clipRenderCaptionDiagnosticsSchema` was already a plain `z.object`, which strips unknown keys, and
`clip.service` reads the column with `safeParse`. With the field gone from the shape, a stored row
`{ omittedCodePoints, skippedEmoji }` parses to `{ omittedCodePoints }`. A row that only listed
skipped emoji reads as nothing to show. No branch handles the old key. The comment on the schema
says it stays a stripping object for this reason, and a test reads a row that carries a field the
shape no longer has. The executor command's `renderVariant` is a `strictObject`, but its
`captionDiagnostics` is that same stripping schema.

### Style derivation (check against the Studio)

`preset` is the preset of the target's first caption layer in the plan. One function,
`captionEmojiStyle(preset)`, builds the style for all three paths:

| Input | Classic | Dynamic | Scene |
| --- | --- | --- | --- |
| palette | `resolveCaptionEmojiPalette(preset, captionEmojiTemplateColours(preset))` | same | same |
| size | `preset.emojiSize ?? 1` | same | same |
| position | `preset.emojiPosition ?? "auto"` | same | same |
| sticker | `preset.emojiSticker ?? true` | same | same |
| shadowColour | `captionEmojiTemplateColours(preset).shadow` (= `preset.shadowColor`) | same | same |
| slot | `"above"` | `"above"` | `captionSceneEmojiSlot(preset.scene)` |
| anchorYPct | first caption layer's `anchor.yPct` | same | same (`sceneInputForLayers` builds the scene at `first.anchor`, so this equals `sceneInput.anchor.yPct`) |
| bodyPx | `geometry.px` (`preset.fontSize` × fit-to-width) | `preset.fontSize * layout.scale` (the block's one fit scale) | `captionSceneMeta(scene).bodyPx * sceneInput.scale` (= `preset.fontSize`) |
| direction | `captionTextDirection(words.join(" "), language ? languageDirection(language) : undefined)` | same, over the layer's words | same, over the `SceneCue`'s words and language |
| cue box | `lineCueBox`: centre `lineCenterX`, width `lineWidth` (unmeasured: `CAPTION_FIT_WIDTH_FRACTION * width`), top `lineTopY`, bottom `2 * anchorY - lineTopY`, i.e. the faces' win ascent + descent line box about the anchor; turned by the cue tilt about the anchor; plate and pill not included | `blockCueBox(geometry.layout, geometry.words.map(w => w.measured), …)` | `sceneCueBoxes(scene, sceneInput.cues, …)` on the scene that was written |
| fromMs / toMs | `activeRange` × 1000 | `activeRange` × 1000 | from `sceneCueBoxes` |
| fps | the render's output rate (`captionFps`), for placement and the writer alike | same | same |

Points to check against ticket 07:
- The defaults for size, position and sticker are written as `?? 1`, `?? "auto"` and `?? true`,
  following the preset schema's comments. Validators has no shared function for them; one
  (`captionEmojiStyle` moved into validators or caption-scene) would remove the duplicate.
- The classic box is the libass line box (win metrics). The Studio's DOM line box uses
  `line-height: normal`, which may differ slightly.
- A Dynamic cue whose font can't be shaped falls back to the classic line and takes the classic
  box; the Studio keeps the block box (the mismatch ADR 0020 already accepts).

A Scene Style that throws, and a Dynamic cue whose font can't be shaped, both take the classic box
of the classic line they fall back to (tested).

### Layer order

Emoji pieces sit at `CAPTION_EMOJI_Z`, so the writer puts them on ASS layers 100000 and up. Classic
and Dynamic events use layers up to 15, and Scene events use `z * 10 + sub`. The emoji events are
appended to the target's script, which burns at the caption stage; the logo, text and transition
stages come after it in the filter graph. No FFmpeg input or filter was added.

### Events per emoji

One event per piece at 24, 30 and 60 fps: flame 5, flexed-biceps (tone 3) 5, rocket 6, heart-eyes
7, party 8, astronaut 20. The test caps it at 21 (the most layered designs: 19 layers plus outline
and shadow). On the real 58 s clip, 20 emojis add 126 events on both Electric and Reveal (6.3 per
emoji).

### Render time (budget)

Real Urdu clip, 0 to 58.3 s (the source ends 75 s; 58.3 s is the utterance boundary nearest 60),
1080x1920, production encoder and thread policy, `caption-scene-real-render.ts` path, 3 alternating
runs, medians:

| Preset | Without | With 20 emojis | Wall | ffmpeg CPU |
| --- | --- | --- | --- | --- |
| electric (classic) | 8.35 s wall, 49.61 s CPU, 1,114 events | 8.32 s, 49.88 s, 1,240 events | -0.4% (noise) | +0.5% |
| reveal (Scene) | 8.31 s, 49.47 s, 6,378 events | 8.35 s, 49.85 s, 6,504 events | +0.5% | +0.8% |

Building the caption script on the same clip (median of 5, 20 emojis): electric 7.5 -> 12.0 ms,
headline 12.0 -> 16.1, reveal 38.7 -> 40.6, horizon 175 -> 191, lyrics 364 -> 383. Art load: 2 ms
the first time, cached after that. Lyrics placed 16 of 20 on this fast Urdu speech (4 `no-room`,
the case ticket 04 already recorded).

### Real renders (frames I looked at)

The source is the local real clip (`.scratch/motion-captions/out/real/urdu-direction/source.mp4`),
6 emojis per run, with frames at each emoji's pop midpoint (+90 ms) and at rest (+500 ms):

- LTR: an English transcript re-timed onto that source, 0 to 14 s. Electric (classic), Headline
  (Dynamic), Reveal, Horizon and Lyrics (Scene): `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-export/ltr/sheet-ltr.png`, close-ups in
  `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-export/ltr/closeups-ltr.png`.
- RTL: the clip's own Urdu transcript, 0 to 16 s. Electric, Headline, Reveal, Dialogue (slot
  `below`) and Lyrics (slot `beside-end`): `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-export/rtl/sheet-rtl.png`, `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-export/rtl/closeups-rtl.png`.
- Every render passed `validateRenderOutput`, and all 60 emojis were placed.
- Checked in the close-ups: outlines closed; the hard shadow sits under the outline, down and to
  the right; the layers stay aligned through the pop (pop and rest frames have the same shape); no
  seams; colours follow each template (Horizon cyan/pink, Headline green, Lyrics mint, Dialogue
  blue/yellow, tone-3 skin on the biceps). Dialogue puts the emoji under the newest bubble, and
  RTL Lyrics puts it at the line's left (reading) end.
- Nothing needed fixing. Two rest frames caught a rocket mid-fade at its cue's end (90 ms fade),
  which is expected.
- Observation for the palette owner (ticket 02), not changed here: on white-primary presets
  (Electric, Reveal) the flame's outer layer comes out white, so it merges with the white sticker
  outline and reads as a white blob with a yellow core.

Golden `emoji-sequences` case: the harness refuses to capture on this machine (toolchain
`c28672e38c8af8b3` has no pinned fixture hashes). `stage --pin` would write pins into the tracked
`manifest.json`, so I did not run it. Instead I rendered the case's document through the same
production path over its staged source (`talk-gray-720p.mp4` from the golden cache): placed 3,
dropped 2 (`no-time`: the flame and the biceps take their short cues from the start), the party on
the flag cue is not planned, validation ok, 16 emoji events. Strip:
`/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-export/golden-emoji-sequences/strip.png`. Re-capture golden baselines on the pinned toolchain: the
cue summary changed shape in every case (the word tuple lost the always-null emoji, and each cue
gained `emojis`).

### Deploy note

The media image content changes (new package data, the overlay code removed, source SVGs
excluded), so the Worker's `MEDIA_*_TOOLCHAIN_FINGERPRINT` must be updated at deploy. I built no
image.

### Commands

- `bun run --cwd apps/media test`: 1170 pass, 1 skip, 0 fail (77 files, 191 s), including
  `caption-emoji-ass.test.ts` (10 tests) and the scripts tests (41).
- `bun run typecheck`: 17 of 17 successful.
- `bun run lint`: 169 errors, none in files this ticket touched. They are in `.scratch/**`,
  `narriflow-emoji-prototype.html`, web CSS/prototype files and ticket 07's in-progress
  `studio/_components/emoji/` files. `bunx biome check` on every touched file: clean.
- `bun run --cwd packages/services test`: 1677 pass, 1567 skip (DB), 0 fail.
  `bun run --cwd packages/validators test`: 1343 pass. Web: `bun test lib/` 278 pass; the
  omission-note tests 10 pass.
- `bun run check:web-split`: passed. `bun run --cwd apps/api build:worker`: audit passed.

### Found, not mine

The real Urdu clip (`urdu-direction`) has a zero-length word (ہے۔ at 23.38 to 23.38, the next
utterance starting at 23.38). The plan makes it a zero-length caption layer, which
`compileCompositionPlanVisualLayers` rejects (`invalid_clip_composition_visual_layers`). The
document's own full range fails too, so this clip cannot be exported today. Not checked:
whether it predates the emoji work (ticket 02 touched `clip-composition-plan.ts`). For the
benchmark, a scratch copy starts that word 50 ms earlier.
