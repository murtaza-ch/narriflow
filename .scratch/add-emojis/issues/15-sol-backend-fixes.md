# 15 - Backend fixes from the Sol review

**What to build:** The plan, clip-creation and tagger defects the Sol review found. Rules:
[../RULES.md](../RULES.md).

**Blocked by:** [13](13-review-a-fixes.md) (same files)

**Status:** done

## Areas

`packages/composition-plan`, `packages/services` (clip service selection creation, emoji tagging,
suggestion, caption-preset apply, document persistence), `packages/validators/src/emoji-tagging.ts`,
and the consumers of a caption layer's `cueIndex` in `apps/media` and the Studio only if item 1
requires it. Not `packages/caption-scene/src/emoji/**` (ticket 14). Each defect needs a test that
fails before the fix.

## Defects

1. **Inserted scenes break cue identity and export** (reported as a blocker).
   `packages/composition-plan/src/clip-composition-plan.ts` (about line 2457): when a scene block
   is inserted inside a cue, the plan splits the cue's layer into slices
   (`...:scene-slice:<n>`) that keep the original `cueIndex` and the full word metadata (scene
   roles and keys, the Dynamic block). Reproduction: a two-second scene inserted at 1.7 s through a
   cue with a flame at 0.9 s. Reveal (Scene Style) drops the flame as `no-cue`; Lyrics shows it at
   3.60 to 4.60 s; Headline (Dynamic) throws `layoutCaptionBlock needs one measurement and one
   word per block role`.
   - First establish what predates the emoji work: at `refs/emoji-baseline`, do the captions
     themselves (no emojis) export correctly through an inserted scene on a Scene Style and a
     Dynamic Style? Use `git show refs/emoji-baseline:<path>` to read old code; do not check it
     out. Report it.
   - Then fix it in the plan so every consumer is right by construction: each slice is a real cue
     with its own cue index, its scene roles and keys sliced to its words, its Dynamic block
     rebuilt for its words, and its emojis those whose time falls inside it. Renumber so cue
     indices stay unique and ordered within a target. Check every reader of `cueIndex`
     (`git grep -n "cueIndex"`) still agrees, including subtitles, the Studio's live-cue lookup,
     `sceneCuesFromLayers`, and the emoji layer's lookup.
   - Tests: the reproduction above on a classic, a Dynamic and a Scene preset through the plan and
     through the worker's caption build (ASS windows on both sides of the insert, the emoji on the
     side its word is on, no throw); a clip with no inserted scene has an identical plan to before.
2. **A clip made from a transcript selection inherits an emoji onto the wrong word.**
   `packages/services/src/clip.service.ts` (about line 1674): the child clip inherits Studio
   Edits; an emoji whose word is outside the new slice is resolved by nearest time onto the first
   retained word (selection starts at 1.000 s after `party` at 0.800 s: the party popper lands on
   `hospital`). Resolve anchors against the parent's words first and carry only entries whose word
   survives in the new slice, stored under that word's key. The new clip starts with fresh cuts
   and masks, so entries on words that were cut or censored in the parent are carried only if the
   word is in the slice (say which you chose and why).
3. **Apply to all can write a suggestion onto a clip that changed since it was read.**
   `clip-editor-document-persistence.ts` (about line 333) and `clip-caption-preset-apply.ts`:
   emojis are written when the stored map is still empty, but not when the transcript, cuts or
   masks changed between the read and the write. Carry each tagged clip's read revision into the
   write and skip the emojis (still apply the preset) when the revision differs. Count those in
   `failed` so the Studio's message covers them.
4. **The tagger counts invalid reports as tagged, and a partial run can replace a full set.**
   `packages/validators/src/emoji-tagging.ts` (about line 63), `clip-emoji-tagging.ts` (about 95),
   `clip-emoji-suggestion.ts` (about 49): a completed report `{"unexpected":true}` counts as
   tagged; a report with picks and no `serious` field is accepted (🎉 landed on `hospital`).
   Validate the report's shape against the schema before counting it tagged (a report that fails
   validation is a failed chunk and gets the one retry); `serious` is required. Return coverage
   with the result: `complete` only when every chunk was tagged. The suggest route returns that
   flag (`{ emojis, complete }`); the import path keeps partial picks as today. Ticket 16 will make
   Regenerate keep existing emojis when the run was not complete; here, add the field through the
   service, the route, the api-client type and the route's tests, and make the apply service treat
   an incomplete clip as it treats one today (keep what was tagged).
5. Fix the test that cannot fail: `clip-emoji-tagging.test.ts` (about line 120) checks only that
   picks are empty for a malformed reply. Assert the failed and retried counts and what the
   suggest service returns.

## Acceptance

- [x] Items 1 to 5 with tests; the baseline finding for item 1 recorded.
- [x] `bun run typecheck`, `bun run test`, `bun run --cwd apps/api test:inventory`,
      `bun run --cwd apps/api openapi:check`, `bun run --cwd apps/api build:worker`, biome on
      touched files.

## Evidence

Implemented 2026-11-26, test-first: each test below failed before its fix. Nothing committed,
migrated or deployed.

### 1. Inserted scenes

**Baseline finding (before the emoji work).** At `refs/emoji-baseline` the insertion slicer in
`clip-composition-plan.ts` is the same as today except the emoji lines: each slice of a caption layer
kept the whole cue's `cueIndex`, `block` and `scene`. The reproduction (12 words every 0.4 s from
0.2 s, 4 per cue, a 2 s scene at 1.7 s inside `people`, 1.4-1.75 s) was run through the plan and
`compileCompositionPlanCaptions` with emojis off:
- Classic (Electric): correct. Two slices, ASS on both sides, nothing during the scene.
- Dynamic (Headline): **the export fails.** The second slice has 1 word and a 4-role block, so
  `layoutCaptionBlock` throws "needs one measurement and one word per block role". The baseline
  worker only degrades `CaptionShapingError`, so this throw fails the render. This predates the
  emoji work: any Dynamic clip with a Scene Block inside a cue could not export.
- Scene Styles (Reveal, Lyrics): renders without a throw but wrong. Two cues share index 0, and the
  one-word slice reads the first word's role and key (`keys[0]` = `the`), so its hero and identity
  are another word's.
- Separately, and unchanged: Scene Styles keep painting into an inserted scene after the cue before
  it (Reveal's 650 ms tail; Lyrics keeps neighbour lines up). The same happens with the scene between
  cues (anchor 1.8 s: Reveal 54 events, Lyrics 289 inside the scene). That is the style's own timing.

**Fix (plan only).** `captionCueSlice` makes each slice a cue of its own: its words (a word spanning
the scene only for its own part), `scene.roles`/`scene.keys` cut to those words, the Caption
Block's `roles`, `texts`, `keys` and `rows` cut and re-indexed (rows keep each word's row: lead, hero
and tail), and the emojis whose time falls inside it. The block keeps the cue's `seed`, so both
sides keep one look. `numberCaptionCues` then numbers a target's caption layers by position; the
same function runs at both returns of `finalizeCaptionLayers` (ticket 13 item 3), so the rule is
"`cueIndex` is the cue's place in its target", unique and ordered, everywhere.

Readers of `cueIndex` checked: `sceneCuesFromLayers` (cue `index`, now unique), Scene piece ids
(segment 1), the emoji layer's cue lookup and piece ids, `captionSceneEmojiCueBoxes`, classic tilt
(`CAPTION_CUE_TILTS_DEG[cueIndex % n]`), worker glyph and geometry reports, Dynamic seeds
(computed before numbering, unchanged), the Studio (`captionLayerAt` finds the live cue by time;
`utteranceIndex: layer.cueIndex` in `interactive-caption-overlay.tsx` is not read). Subtitles read
words, not indices. No reader in `apps/` or `caption-scene/src/emoji/**` needed a change.

After the fix, same reproduction with the flame on `mistake` (1.0 s): Electric, Headline, Reveal,
Lyrics all render; cues `0[0.20-1.70] 1[3.70-3.75] 2[3.80-5.35] 3[5.40-6.95]`; the flame is placed
(`{ placed: 1 }`) and starts at 1.00 s on every style. Before: Headline threw, Reveal dropped it as
`no-cue`, Lyrics drew it 3.60 to 4.60 s. Lyrics now holds it 1.00 to 3.60 s, because Lyrics keeps
cue 0's own pieces painting into the scene (above).

Tests:
- `composition-plan/src/clip-composition-plan.test.ts` "a Scene Block inserted inside a cue splits it
  into two real cues": Electric, Headline, Reveal give cues `[0, 1, 2, 3]`, the words on each side,
  the windows, the flame only on the first side (`["flame", 1, 0]`), roles/keys parallel to words,
  Headline's second block `{ keys: ["1400"], rows: [[0]], seed: <first's> }`, Reveal's second scene
  `{ keys: ["1400"], roles: [<first's 4th>], speaker: 0 }`; block rows cover each cue's words; a scene
  between cues leaves cues whole.
- `apps/media/src/caption-inserted-scene.test.ts` (new): the worker's caption build for the three
  paths: no notice, caption events before and after the scene, none inside it for classic and
  Dynamic, `{ placed: 1, dropped: {} }`, emoji events starting at 1.0 s and before the scene.
  With the old slicing restored, Dynamic and Scene fail (classic passed before, as the baseline says).
- A clip with no inserted scene has an identical plan: the 230-plan hash `e4e2633d…` (ticket 13
  item 3) is the same before and after.

### 2. Create from a transcript selection

`planCaptionEmojisForClipFromSelection(source, slice)` (`clip.service.ts`): each entry resolves to
the source clip's word with the plan's rule (`resolveCaptionEmojiAnchors`), then carries only to the
same word in the new slice (same Word Key, or the word a clamped source start lies in), stored under
that word's key. `planStudioEditsForClipFromSelection` no longer copies `captionEmojis`;
`createClipAtRange` writes the carried map (`NewClipLook.captionEmojisFrom`). Choice for cut or
censored words: they are carried when the word is in the slice, because the new clip starts without
the source's cuts and masks, so the word shows again and the entry is still the user's pick for it.
Tests `clip-create-from-selection.test.ts`: a selection from 1.000 s after `party` (0.8 s) carries
nothing onto `hospital`; a re-timed key (1580) moves to `tonight`'s key 1500 and a tone survives; a
source word clamped to the source clip's start (0.9 s) finds its full word (0.8 s); the parent's map
is not copied.

### 3. Apply to all on a changed clip

The `set_caption_preset` intent now carries `captionEmojis: Map<clipId, { revision, emojis }>`.
`planProjectSelectionDocument` writes the emojis only while the clip is still at that revision and
has none; the result gains `captionEmojisStale` (clips that changed since and still have none), which
`applyCaptionPresetToProject` adds to `failed`. A clip that got emojis meanwhile is in neither, as before.
Test `clip-caption-preset-apply.test.ts` "a clip whose words changed while the model ran": a line
rewrite on one clip and a cut on another during tagging give `{ added: 1, failed: 2 }`, the preset on
all three, no emojis on the two changed clips. `.db.test.ts` expectations edited mechanically (not run).

### 4. Invalid reports and coverage

- `acceptEmojiPicks` returns `null` for a report that is not `EMOJI_TAGGING_SCHEMA`'s shape;
  `serious` is required (no `.default([])`). `tagCaptionEmojis` treats a null as a failed chunk,
  which gets the one retry.
- `ClipEmojiSuggestion.complete` = every chunk tagged (`true` when there was nothing to tag).
  `clipService.suggestEmojis` returns `{ emojis, complete }`; the route passes it through, so the
  api-client type (inferred from the route) has `complete: boolean`. No OpenAPI change (first-party route).
- Import keeps partial picks as before. The apply service is unchanged in behaviour: a partial clip
  keeps what was tagged (new test "a clip tagged only in part keeps what was tagged").
- Tests: validators "a report that is not the schema's shape is invalid (null)" (`{"unexpected":true}`,
  picks without `serious`, wrong types); services "a valid report on the retry counts as tagged",
  "a run is complete only when every chunk was tagged; a partial run keeps what was tagged"; route
  test returns `{ emojis, complete: false }`; api-client test reads `complete`.

### 5. The test that could not fail

`clip-emoji-tagging.test.ts` "a cut-off reply, text that is not JSON or a report of another shape is
a failed chunk, sent once more": four replies (cut-off stream, not JSON, `{"unexpected":true}`,
🎉 picks without `serious`); each asserts 2 requests, `{ tagged: 0, failed: 1, retried: 1, rateLimited: 0 }`,
`suggestClipEmojis` returning `{ emojis: {}, complete: false }` and
`clipEmojiSuggestionFailure` = `clip_emoji_suggestion_failed`.

### Verification

Same run as ticket 13's Evidence: typecheck 17/17; `bun run test` all suites pass except one
`caption-emoji` test (ticket 14's, passes on re-run, 104/104); inventory 302 routes, 0 problems;
`openapi:check` matches; `build:worker` audit passed; `check:web-split` passed; biome clean on the
42 touched files.
