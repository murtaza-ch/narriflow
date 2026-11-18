# 03a - Pure core

**What to build:** The plan carries Caption Blocks for dynamic presets, with shared geometry and motion data (spec 5.2 to 5.8).

**Blocked by:** 00, 01, 02

**Status:** done

Spec: [../spec.md](../spec.md). Follow the spec; where a ticket and the spec disagree, the spec wins.

## Acceptance

- [x] Preset fields (5.2), `caption-dynamic.ts` with Headline, soft cue breaks for every preset (5.4), roles as a second pass, `block` on caption layers including the dub `captionOverride` path (5.5), `captionCueBlock`.
- [x] `packages/caption-fonts/src/caption-block.ts` exported as `@narriflow/caption-fonts/caption-block` (no `node:` imports) implementing 5.6 rules 1 to 10.
- [x] `CaptionKeyframe.offsetXEm/rotateZDeg`, `CaptionMotionSpec.hero`, `slide`; `caption-style.test.ts` keeps enforcing libass limits.
- [x] Emoji nulled for dynamic presets; subtitles and the clip timeline read `words[].text`.
- [x] `GLOSSARY.md` terms (5.1) and an ADR for decisions 1 and 2 (`docs/adr/`).
- [x] Unit tests for rows, geometry rules, duration cap, seeds; `caption-preset.test.ts` updated for the new group.
- [x] `bun run lint`, `bun run typecheck`, `bun run test` pass (Bun 1.4.4). No PostgreSQL or heavy suites.

## Comments

### Opus, 2026-11-19: pure core landed

**What changed**

- `packages/validators`: preset fields `dynamic`, `heroFontName`, `accentColor`, `emphasisScale`, plus `curve` and `heroBehind` (validation only). New `caption-dynamic.ts`: the 5.8 types, `CAPTION_DYNAMIC_STYLES` with Headline, `CAPTION_BLOCK` constants, `CaptionBlock`, `captionBlockRows`, `captionBlockSeed` (FNV-1a), `captionBlockAnimation` (word-reveal motion without an effect and not jelly, else the style default), `captionBlockWordsPerCue` (2 to 5) and `captionRoleLook` (face, case, spacing and colour per role). Headline is the first catalog preset, in a new "Dynamic" group listed first. `caption-style.ts`: `offsetXEm`, `rotateZDeg`, `CaptionMotionSpec.hero`, `slide`, `captionEntranceKeyframes`, `captionEntranceMs`, and `captionEntranceTimeScale` (the 5.7 duration cap). `caption-cues.ts`: `captionSoftBreaks` and the optional `softBreakAfter` argument of `groupCaptionTokens`. `studio-edits.ts`: optional `captionEmphasis` (digit keys, 2,000 cap), compared in `studioEditsEqual`.
- `packages/composition-plan`: soft breaks on the transcript and dub paths for every preset. Roles run as a second pass over all of a target's cues, with `studioEdits.captionEmphasis` overrides; dub cues get null keys. An optional `block` goes on the caption layer, and `captionCueBlock` is the shared builder. Emoji is null for dynamic presets. A left style defaults `positionX` to `leftGuidePct`. Fixture manifest at `src/__fixtures__/dynamic-captions/manifest.json` (9 cases).
- `packages/caption-fonts/src/caption-block.ts` (`@narriflow/caption-fonts/caption-block`): `layoutCaptionBlock`, rules 1 to 10. It reserves entrance travel, scale growth and `rotateZDeg` in `bounds` and applies the safe-area shift. A comment marks where curved rows (5.11) replace straight row placement. A test bundles it for the browser and asserts there are no `node:` imports.
- `apps/media/src/caption-ass.test.ts`: the classic snapshot iterates classic presets only. The snapshot file is byte-identical (24 snapshots pass).
- `apps/web/app/(app)/_shared/caption-preset-backdrops.ts`: Headline backdrop (needed by typecheck).
- Public OpenAPI document and REST snapshot regenerated (`headline` joins the preset id enum, 2 lines each).
- `GLOSSARY.md` (Dynamic Style, Caption Role, Caption Block, Word Key) and `docs/adr/0020-caption-block-geometry.md`, linked in the ADR index.

**Interpretations** (for review)

1. `captionCueBlock(words, preset, language, cueIndex, roles)` takes the roles as a fifth argument. The scorer needs per-utterance statistics and the previous cue, so a single cue cannot score itself. Thumbnails call `assignCaptionRoles` on their sample cue first. `words` carries text before the case transform, because a role's case (for example the hero's "none") cannot be recovered from upper-cased text.
2. `CaptionDynamicStyle` gains `softShadow` (Headline: black 65%, sigma 0.0375 em, 0.025 em down, which is 6 px CSS blur and 2 px at S = 80) and `accentColor`. The preset's `shadow` enum cannot express the catalog's shadow, and 5.2 says the accent "defaults per style".
3. Headline `noHeroSizeEm` is 1.2. The catalog does not give one, so this is a value for visual review. Hero `sizeEm` 2.2 is used only when there is no fill (a `row` layout). Hero fill applies only to a stack hero row. `emphasisScale` multiplies the hero with or without fill.
4. Stagger signs: row 0 takes the seed's sign, the hero row always takes the seed's sign (it never shifts), and each later non-hero row takes the opposite of the previous non-hero row. For a hero-first cue this gives the tail the opposite sign; the ticket 02 proof gave it the same sign.
5. Rotation (rule 10) is applied about the rest-box centre before the safe-area shift (rule 9), so the shift covers turned corners. Anchoring is unchanged, because the turn keeps the centre.
6. An RTL cue in a left style puts its right edge at `100 − xPct` percent.
7. Tile padding is added to every gap, including `spaceBefore: false` joins, so tiles never overlap. `CAPTION_BLOCK.wordGapEm` is 0.232, the Inter SemiBold space the proof used.
8. `PlacedWord.baselineX/Y` are given in the word's own frame before its rotation, and `centerY` sits at the word's own ink middle. Painters rotate about the centre.
9. Untimed utterances are scored, as the G1 sheet scores them, so the repeat penalty restarts after them, but they get no block. A punctuation-only token hidden by the Punctuation toggle passes its soft break to the previous word.
10. Headline preset: `textTransform: "none"` (transcript sentence case) and `letterSpacing: 0`.
11. `captionEmphasis` is optional with no default, so existing documents and fixtures need no churn. `studioEditsEqual` treats absent and `{}` as equal.

**Open, for later tickets**

- `slide` appears in every animation picker, including classic presets. Both classic painters ignore `offsetXEm`, so a classic preset on `slide` fades in, the same in both renderers (03b, 04).
- The Captions panel preview (`getCurrentCaptionState`) still groups without soft breaks until 03c deletes it. The overlay reads the plan.
- `emphasis-sheet.ts` still groups without soft breaks. G1 is done, so it was left unchanged.
- `CAPTION_EMPHASIS_WEIGHTS` still holds the starting values; ticket 01 records the tuned ones. Every fixture's expected roles were checked under both weight sets.

**Spec notes**

- 5.5's four-argument `captionCueBlock` cannot work as written (item 1). Section 6's Headline shadow needed a style field (item 2). 5.6 rule 6 is ambiguous when row 0 is the hero (item 4). Section 10 put the REST and OpenAPI regeneration in 03c, but the new preset id lands in 03a, so it was done here.

**Verification** (Bun 1.4.4, worktree root)

- `bun run lint`: 0 errors (20 warnings and 1 info, none in changed code).
- `bun run typecheck`: 15 of 15 tasks pass.
- `bun run test`: exit 0. validators 869, composition-plan 125, caption-fonts 109, services 1621, api 984, api-client 232, web 1135, media 987 pass (1 skip), and the other packages pass; 0 failures anywhere.
- `bun run --cwd apps/api test:inventory`: 301 routes, 0 problems.
- `bun run --cwd apps/api openapi:check`: the artifact matches all 32 REST operations.
- `bun run check:web-split`: passed.

