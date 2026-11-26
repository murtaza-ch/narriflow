# 02 - Contracts and plan

**What to build:** The schemas, pure rules and plan output every other ticket builds on (spec D6,
D7, the pure part of D8). Rules: [../RULES.md](../RULES.md). Spec: [../spec.md](../spec.md).

**Blocked by:** None.

**Status:** done

## Areas

`packages/validators`, `packages/composition-plan`, and the reducer in
`packages/validators/src/editor-document.ts`. Nothing in `apps/*`.

## Deliverables

### `packages/validators/src/caption-emojis.ts` (new, exported from the package the way
`caption-emphasis.ts` is)

- `captionEmojiRefSchema`: `{ id: kebab slug, 1-80 chars; tone?: integer 1-5 }`. Validators does
  not import the catalog; an unknown id is dropped by the renderers.
- `captionEmojisSchema`: `Record<WordKey, CaptionEmojiRef>`, at most 500 entries, using the
  existing `captionWordKeySchema` (`studio-edits.ts`).
- `captionEmojiPaletteSchema`: `{ a, b, c }` as `#RRGGBB`.
- `CAPTION_EMOJI_PALETTES`: the owner's four, as `{ id, name, palette }`:
  Bubblegum `#ffe45c #ff4f9a #ffffff`, Jelly `#a3ff12 #7c3aed #ffffff`,
  Candy `#ffd23f #ffffff #ff5fa2`, Retro `#59f0d2 #1a1a1a #fff3d6` (a, b, c).
- `CAPTION_EMOJI_INK = "#271e35"` (the art's fixed ink) and `CAPTION_EMOJI_SIZES = [0.8, 1, 1.25]`.
- `captionEmojiPalette(colours: { primary; highlight; accent; shadow }): { a; b; c }` per spec D6.
  Invariants, tested over every entry of `CAPTION_PRESETS` (use each preset's resolved scene
  colours the way `sceneInputFromPreset` in `packages/caption-scene/src/registry.ts` resolves them;
  compute them locally without importing caption-scene): `a` is separated from the ink and from `c`,
  `b` is separated from `a`. State the metric and thresholds you chose (contrast ratio or a
  perceptual distance) in a comment and assert them. Deterministic, no randomness.
- `resolveCaptionEmojiPalette(preset, colours)`: `preset.emojiPalette ?? captionEmojiPalette(colours)`.
- Density: `CAPTION_EMOJI_DENSITIES = { light: 5, balanced: 2.5, expressive: 1.5 }` (seconds),
  `captionEmojiDensitySchema`, and
  `selectCaptionEmojiPicks(picks, words, density)` where a pick is `{ key, ref, strength }` and
  `words` gives each kept word's key and edited-time start. Rules in spec D8: drop picks whose key
  is not a kept word; keep at most one pick per minimum gap, the stronger wins and the earlier wins
  a tie; the same emoji id does not repeat within 10 s; a pick in the first 3 s is kept when one is
  offered. Pure and deterministic. Returns `Record<WordKey, CaptionEmojiRef>`.
- `resolveCaptionEmojiAnchors(entries, words)`: for each stored entry, the kept word whose source
  start is nearest, within 400 ms; exact key match first. Two entries that resolve to one word: the
  nearer wins. Returns the word index (or key) per entry so the plan can attach emojis.

### `packages/validators/src/caption-preset.ts`

- Keep `emojis: boolean`. Add `emojiPalette?`, `emojiSize?` (one of `CAPTION_EMOJI_SIZES`),
  `emojiPosition?: "auto" | "above" | "below"`, `emojiSticker?: boolean`. Add all four to
  `CAPTION_PLACEMENT_FIELDS` next to `emojis`, and check that preset matching and equality treat an
  object-valued placement field correctly (`matchCaptionPreset` compares with `!==`;
  `captionPresetsEqual` loops keys). Fix the comparison where an object value would break it, and
  test it.
- Update the comment that says Dynamic Styles ignore `emojis`: every preset kind draws emojis now.
- Leave `CAPTION_EMOJI_MAP` and `emojiForWord` in place; ticket 10 deletes them once nothing reads
  them.

### `studio-edits.ts` and `editor-document.ts`

- `studioEdits.captionEmojis?: captionEmojisSchema`, with a `withCaptionEmojis` helper that mirrors
  `withCaptionEmphasis` (an empty map is stored as absent) and the same equality treatment.
- Reducer actions, each one undo step, modelled on `setCaptionEmphasis`:
  `{ type: "setCaptionEmojis", entries: Record<WordKey, CaptionEmojiRef | null> }` (null removes)
  and `{ type: "replaceCaptionEmojis", value: Record<WordKey, CaptionEmojiRef> }` (AI regenerate and
  Remove all). Check every place that enumerates studio-edit keys or reducer actions (codec,
  equality, reset to original, apply-edits patch schema) and extend it where needed.

### `packages/composition-plan`

- `CompositionCaptionVisualLayer.emojis: readonly { id: string; tone?: number; atSec: number }[]`
  (edited time), built in `captionLayersForTarget` from `document.studioEdits.captionEmojis` when
  `preset.emojis` is on, for every preset kind including Dynamic Styles:
  anchors resolved with `resolveCaptionEmojiAnchors` over the target's kept source words; an emoji
  joins the cue that contains its word; masked (censored) words take none; a cue whose text already
  contains an emoji cluster (`isCaptionEmojiCluster` from `@narriflow/caption-fonts`) takes none.
  Dub targets (words without a Word Key): map the anchor's source time through the edited-time map
  and attach to the cue live at that time.
- Stop deriving the keyword emoji: remove `emojiFor` and the `emojiForWord` import. Keep the field
  `CompositionCaptionWord.emoji` and set it to `null` everywhere for now, with a one-line comment
  that tickets 06, 07 and 10 remove the readers and then the field. This keeps `apps/media` and
  `apps/web` compiling while they are rebuilt.
- Update the tests that expected keyword emojis (`dynamic-captions.test.ts`,
  `caption-override.test.ts`, others you find) and add tests for: exact key, nearest key after a
  re-timed line, a cut word, a censored word, a typed emoji in the cue, a dub target, switch off.

## Acceptance

- [x] All of the above exported and tested.
- [x] Palette invariants hold for all presets (print the worst case per invariant in Evidence).
- [x] `bun run typecheck` passes for the whole repository (nothing in `apps/*` breaks).
- [x] `bun run lint`; tests of `packages/validators` and `packages/composition-plan` pass.

## Evidence

Implemented 2026-11-26.

### Files

- `packages/validators/src/caption-emojis.ts` (new): ref/map/palette/size/position/density schemas,
  `CAPTION_EMOJI_PALETTES`, `CAPTION_EMOJI_INK`, `CAPTION_EMOJI_SIZES`, `captionEmojiPalette`,
  `resolveCaptionEmojiPalette`, `captionEmojiColourDistance`, `selectCaptionEmojiPicks`,
  `resolveCaptionEmojiAnchors`. Exported from the package index.
- `packages/validators/src/caption-emphasis.ts`: `captionWordKeySchema` moved here from
  `studio-edits.ts` (same export name, still in the index) so `caption-emojis.ts` and
  `studio-edits.ts` do not import each other.
- `packages/validators/src/caption-preset.ts`: `emojiPalette`, `emojiSize`, `emojiPosition`,
  `emojiSticker`; all four in `CAPTION_PLACEMENT_FIELDS`; `captionPresetsEqual` compares
  `emojiPalette` by value; comments updated (every preset kind draws emojis).
- `packages/validators/src/studio-edits.ts`: `captionEmojis?`, `withCaptionEmojis`,
  `replaceCaptionEmojis`, equality.
- `packages/validators/src/editor-document.ts`: `setCaptionEmojis`, `replaceCaptionEmojis` actions.
- `packages/composition-plan/src/caption-emoji-plan.ts` (new): anchor resolution over the
  transcript, dub timing, attaching emojis to cues.
- `packages/composition-plan/src/clip-composition-plan.ts`: `CompositionCaptionEmoji`,
  `CompositionCaptionVisualLayer.emojis`; keyword emoji removed (`word.emoji` is always null);
  inserted scenes shift emojis with their words.
- `packages/composition-plan/package.json` + `bun.lock` (one line): depends on
  `@narriflow/caption-fonts` for `isCaptionEmojiCluster` (`/emoji` subpath; ticket 10 moves it).
- Outside the named areas (minimal): `apps/media/scripts/caption-frames.ts` (`emojis: []` on a
  hand-built layer, for typecheck); `apps/media/src/composition-emoji.test.ts` (sets the old
  keyword emoji on planned words itself, so the FFmpeg overlay tests keep running until ticket 06
  deletes that chain).

Checked: the codec (`clip-editor-document-codec.ts`) parses `studioEdits` with `studioEditsSchema`
and persistence stores it as one JSON blob, so nothing whitelists keys. Reset restores the
original document whole. The apply-to-all patch schema is strict and rejects `captionEmojis`
(ticket 11 adds it there).

### Palette

Metric: ΔEok (Euclidean distance in OKLab). Thresholds: body–ink ≥ 0.30, body–detail ≥ 0.12,
rim–body ≥ 0.12. The owner's four palettes measure body–ink ≥ 0.632 (Retro), body–detail ≥ 0.171
(Retro), rim–body ≥ 0.202 (Candy). Contrast ratio was rejected: Bubblegum's yellow on white is 1.2.

Worst case per invariant over all 115 `CAPTION_PRESETS` (scene colours resolved as
`sceneInputFromPreset`; Dynamic accent as its slot colour; classic accent = highlight):

| Invariant | Worst preset | ΔEok | Palette |
| --- | --- | --- | --- |
| a vs ink | tape | 0.315 | a `#402eec`, b `#d4ff3a`, c `#ffffff` |
| a vs c | broadway | 0.133 | a `#ffd060`, b `#b39251` (derived), c `#fff3d6` |
| b vs a | labels | 0.142 | a `#ffe600`, b `#f4e9c3`, c `#ffffff` |

17 presets take a fallback body (monochrome templates such as Stack, Punch, Glitch get `#ffe45c`;
Arc gets `#59f0d2` because its cream primary sits near yellow), 4 take the accent as body, 26
derive the rim from the body.

### Measured

- Plan cost, 60 s clip, 160 words, 20 emojis (all keys 30 ms off, so every one takes the nearest
  search): 0.60 ms per plan with emojis off, 0.76 ms with them on (500 runs each, Bun 1.4.4, M-series).
- Worker bundle: `@narriflow/caption-fonts/emoji` now enters it through the plan (inputs
  `emoji.ts` 6.3 kB + `atlas.json` 4.6 kB, plus `caption-emojis.ts` 13.5 kB and
  `caption-emoji-plan.ts` 5.4 kB unminified). The atlas leaves when ticket 10 moves the grapheme helpers.

### Verification

- `bun test` in `packages/validators`: 1326 pass, 0 fail.
- `bun test` in `packages/composition-plan`: 180 pass, 0 fail.
- `bun run typecheck --continue`: 17 of 17 tasks successful.
- `bun run lint`: fails with 168 errors, all in untracked `.scratch/**`, `narriflow-emoji-prototype.html`
  and two web CSS files not touched here; `bunx biome check` on every file this ticket touched: clean.
- `bun run test --continue`: every suite passes (media 1170, web 1252, api 985, services 1650,
  caption-scene 2995, …) except `@narriflow/caption-emoji` (ticket 01, being edited:
  `entry[2].map` of undefined in its own test).
- `bun run --cwd apps/api build:worker`: audit passed. `test:inventory`: 301 routes, 0 problems.
  `openapi:check`: matches. `check:web-split`: passed.
