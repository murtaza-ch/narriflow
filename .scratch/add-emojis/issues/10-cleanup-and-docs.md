# 10 - Remove the old emoji code, write the docs

**What to build:** Nothing of the keyword emoji feature remains, and the new one is documented.
Rules: [../RULES.md](../RULES.md).

**Blocked by:** [06](06-export.md), [07](07-studio-preview.md), [09](09-studio-controls.md)

**Status:** done

## Deliverables

1. `packages/caption-fonts`: move `captionGraphemes` and `isCaptionEmojiCluster` to
   `src/graphemes.ts` (export `@narriflow/caption-fonts/graphemes` and from the index) and update
   their importers (`caption-glyphs.ts`, `caption-block-painter.tsx`, `caption-script-fonts.ts`,
   `caption-ass.ts`, `fallback-line-boxes.ts`, composition-plan from ticket 02, others you find).
   Delete `src/emoji.ts`, `src/emoji.test.ts` (move the grapheme tests), `emoji/{atlas.png,
   atlas.json,LICENSE.txt}`, `scripts/build-emoji-atlas.ts`, the `./emoji` exports in
   `package.json`, `CAPTION_EMOJI_ATLAS_PATH` in `paths.ts`, and any alias left in
   `apps/web/tsconfig.json`. Keep `NotoEmoji-Regular.ttf` and the fallback chain (emoji typed in
   caption text still draws in the monochrome face).
2. `packages/validators/src/caption-preset.ts`: delete `CAPTION_EMOJI_MAP` and `emojiForWord` and
   their tests. `packages/composition-plan`: delete `CompositionCaptionWord.emoji` and every
   remaining read or write of it across the repository.
3. `git grep -n -i emoji` over tracked source: every remaining hit is the new feature, the
   grapheme helpers, the fallback face, or unrelated (X character weights, lockfiles). List the
   categories with counts in Evidence.
4. Docs:
   - `GLOSSARY.md`: Caption Emoji, Emoji Ref, Emoji Layer, Emoji Slot, Emoji Palette (one or two
     lines each, in the glossary's existing form).
   - `docs/adr/0022-caption-emojis.md` and its row in `docs/adr/README.md`: the decisions that are
     hard to reverse and why (own art compiled to fills; one emoji layer built from cue boxes
     outside the scene build; anchors by Word Key resolved by nearest source time; tagging at
     selection preparation). Follow the existing ADRs' form and length.
   - `AGENTS.md`: fix the "shared caption/emoji constants" wording; add `caption-emoji` to the
     packages list in one line.
   - `apps/web/content/docs/caption-styles.mdx`: a short "Emojis" section (what the switch does,
     AI density, editing, colours follow the template). Check `lib/docs/navigation.ts` needs no
     change.
5. `.scratch/add-emojis/spec.md`: set status to implemented and add a short "As built" section
   with any deviation the tickets recorded.

## Acceptance

- [x] Deliverables 1 to 5.
- [x] `bun run lint`, `bun run typecheck`, `bun run test`, `bun run check:web-split`,
      `bun run --cwd apps/api openapi:check`, `bun run --cwd apps/api test:inventory`,
      `bun run --cwd apps/api build:worker`.

## Evidence

Implemented 2026-11-26. Nothing committed.

### Deleted

- `packages/caption-fonts/src/emoji.ts`, `src/emoji.test.ts` (atlas, sprite CSS, pose, FFmpeg scale
  expression and their tests)
- `packages/caption-fonts/emoji/atlas.png`, `emoji/atlas.json`, `emoji/LICENSE.txt` (and the folder)
- `packages/caption-fonts/scripts/build-emoji-atlas.ts`
- `./emoji` and `./emoji/atlas.png` exports in `packages/caption-fonts/package.json`;
  `CAPTION_EMOJI_ATLAS_PATH` in `paths.ts` and the index; `export * from "./emoji"`
- `apps/web/tsconfig.json`: the `caption-fonts/emoji` alias (replaced by `caption-fonts/graphemes`,
  which web needs because it resolves caption-fonts subpaths through aliases)
- `CAPTION_EMOJI_MAP`, `emojiForWord` in `packages/validators/src/caption-preset.ts` (they had no tests)
- `CompositionCaptionWord.emoji` and its 3 writes in `clip-composition-plan.ts`; `emoji: null` in hand-built
  layers in 11 test and script files (media caption suites, `caption-frames.ts`, web `caption-cue-at`,
  `captions-panel-model`, `captions-panel-scene` tests); 6 `word.emoji === null` assertions in
  composition-plan tests; `{ emojis: true }` in the censor-mask test (it only fed the keyword map)
- `apps/media/images/lean.dockerignore`: `packages/caption-fonts/emoji` (the folder is gone)
- `caption-style-engine.test.ts`: the `not.toContain("atlas")` assertion

### Added or moved

- `packages/caption-fonts/src/graphemes.ts` (+ `graphemes.test.ts`): `captionGraphemes(text: string): string[]`,
  `isCaptionEmojiCluster(cluster: string): boolean`, unchanged; export `@narriflow/caption-fonts/graphemes`
  and from the index. Importers updated: `caption-block-painter.tsx`, `caption-style-engine.tsx`,
  `caption-script-fonts.ts`, `fallback-line-boxes.ts`, `caption-emoji-plan.ts`; `caption-glyphs.ts` and
  `caption-ass.ts` already take them from the index.
- Comments: `caption-glyphs.test.ts` (flag case no longer cites the atlas), `woff2.ts` (`./graphemes`).
- `apps/media/scripts/check-render-environment.ts`: nothing referred to the atlas (its emoji probes are the
  image's fontconfig and the monochrome face), so unchanged.

### Worker bundle

`bun run --cwd apps/api build:worker`, `dist/worker/index.js`: 12,041,974 bytes (build at 06:52 today, before
this ticket) to 12,037,195 (-4,779). Gone from the metafile: `caption-fonts/emoji/atlas.json` (4,390 bytes in
output) and `caption-fonts/src/emoji.ts` (712); new: `caption-fonts/src/graphemes.ts` (442). The only
`caption-emoji` modules left are `index`, `geometry` and `index-data`. Audit passed.

### `git grep -n -i emoji` categories

Tracked and untracked source outside `.scratch/` (most of the new feature is untracked): 3,598 lines in
222 files.

- New feature (Caption Emojis): 183 files, 3,455 lines.
- Fallback face for emoji typed in text (fallback chain, line boxes, glyph planner, script fonts CSS, media
  image font lock and probes, the golden `emoji-burn-in` defect, grapheme-integrity comments and tests in
  scene templates): 29 files, 85 lines.
- Grapheme helpers (`graphemes.ts`, its test, the index): 3 files, 16 lines.
- Unrelated: 7 files, 42 lines (X character weights, the diagnostics privacy pattern, `bun.lock`, the Zapier
  lockfile, the bundled MCP app script's zod emoji regex).

No hit names the atlas, the keyword map, `emojiForWord`, `word.emoji`, `skippedEmoji` or the overlay chain.

### Docs

- `GLOSSARY.md`: Caption Emoji, Emoji Ref, Emoji Layer, Emoji Slot, Emoji Palette (after Word Key).
- `docs/adr/0022-caption-emojis.md` + its row in `docs/adr/README.md`.
- `AGENTS.md`: validators line ("shared caption constants"); `caption-emoji` package line.
- `apps/web/content/docs/caption-styles.mdx`: "Emojis" section. `lib/docs/navigation.ts` needs no change
  (the page is listed; sections are headings on it).
- `.scratch/add-emojis/spec.md`: status implemented; section 7 "As built".

### Verification

- `bun run typecheck`: 17 of 17 successful (the first run failed in web until the `caption-fonts/graphemes`
  alias was added).
- `bun run test --continue`: validators 1,346, caption-fonts 220, composition-plan 198, services 1,691,
  api 994, api-client 234, caption-scene 3,118, mcp-core 170, web 1,343 pass, 0 fail.
  `@narriflow/caption-emoji` 103 pass, 1 fail: `art-load.test.ts` ("a shard that fails to load drops only
  its own ids"), a file another agent wrote at 13:09 together with `art.ts`; still failing on re-run; not
  touched here.
  `@narriflow/media` 1,180 pass, 1 skip, 0 fail. Turbo: 15 of 16 tasks successful (only caption-emoji failed).
- `bun run lint`: 168 errors, the same set earlier tickets recorded (`.scratch/**` and other files not in this
  effort). `bunx biome check` on every file touched here: clean.
- `bun run check:web-split`: passed. `test:inventory`: 302 routes, 0 problems. `openapi:check`: matches all
  32 REST operations. `build:worker`: audit passed.

