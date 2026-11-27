# 34 — No placeholder discs, honest density copy, fewer wrong picks

Status: done (2026-11-27; ADR 0022 / spec lines left to the orchestrator, ticket 33 owns those files)
Depends on: 32

## Why

Owner's live test, 2026-11-27 (all 10 clips of project e1fb3684 tagged, one export): "Please fix the
issues." Found:

1. **Grey placeholder circles** in the "In this clip" list and transcript row buttons for 1–5 s after an
   AI run (Regenerate and the AI tools row Apply), before the art loaded. Standing owner rule: never show
   placeholder emojis.
2. **Density hints are outdated**: "Only the surest matches…", "Clear matches at an easy pace.", "Every
   good match, close together." Since ticket 32 the densities are about frequency.
3. **Wrong / weak picks**: 🤝 on "disagree" (wrong: the opposite meaning); 🔐 on "like", 😐 on "Just" /
   "Like," (discourse words); 💀 on "carbon" (carbon monoxide; danger, not death).

## What is known (read-only investigation, 2026-11-27)

- Disc drawn at `apps/web/.../studio/_components/emoji/emoji-glyph.tsx:64-68` (returned `:77`); picker
  cells too (`emoji-picker.tsx:370`, `emoji-picker-parts.tsx:46,49`). `caption-emoji-runs.ts:327` commits
  the answer without loading its art; each glyph then loads its own shard (`use-caption-emoji-art.ts:56`,
  17 shards ≈ 1.03 MB gzip; a 20-emoji answer needed 6 shards ≈ 359 KB gzip). The canvas waits for art
  (no disc) but can draw some emojis and skip the rest until loaded (`caption-emoji-layer.tsx:101-105`,
  `packages/caption-scene/src/emoji/layer.ts:241`).
- Copy: `emojis-section.tsx:23-25`, asserted in `emojis-section.test.tsx:194-196`; docs
  `apps/web/content/docs/caption-styles.mdx:477-483` (also says "Captions → Emojis" and "On screen now",
  both outdated since ticket 31).
- Picks: no antonym guard; a `no` reply on 🤝 would be dropped, so the model said yes. `like` / `just`
  are fillers only in the highlight list (`caption-emphasis-words-en.ts:23-25`), not for emoji
  eligibility (`emoji-tagging.ts:66`). 60 of 1,057 requested lines (5.7%) on 33 ordinary clips anchor on
  such a word; for 19 (1.8%) it is the only eligible word.

## Decision (orchestrator)

1. **Load art before showing an AI result**: pass a `loadArt` dependency (from
   `preloadCaptionEmojiArt`) into the run, await it for the answer's ids after `caption-emoji-runs.ts:316`
   and before the live-source merge at `:321`. Covers Regenerate and Apply. A failed load still commits
   (the edit must not be lost) and the glyph stays an empty box until art arrives.
2. **No disc anywhere**: an unloaded glyph or picker cell renders an empty box of the same size (no grey
   fill, no outline), keeping layout stable.
3. **Copy**: Light "Fewer emojis, on the key words.", Balanced "An emoji on most captions.", Expressive
   "As many as fit, close together." (adjust if a shorter honest line reads better; keep plain words).
   Update the test and the docs lines 477–483 (AI tools → Add emojis → Emojis panel; "Add to a word").
4. **Prompt rules** in `emojiTaggingSystemPrompt` (keep it short):
   - A word that rejects or reverses an idea (disagree, dislike, unhappy, impossible, unsafe; any
     language) never takes the positive idea's emoji: use 👎 / ❌ / 🙅 or the feeling meant, or mark `no`.
   - Do not picture a discourse word itself (like, just, so, well, basically, actually, literally).
   - Danger, risk or warning → ⚠️ / 🚨; 💀 only when death itself is the point (or clearly a joke).
5. **Code**: in the eligible-word lettering, English discourse `like` / `just` get no letter when the line
   has another eligible word (keep them when they are the only one, so no line loses its answer). Leave
   Hindi/Urdu lists unchanged.

## Done when

- Web tests: an AI run commits only after its art loaded (fake loader); a failed load still commits; the
  glyph and picker cell render no disc while loading (assert no placeholder fill element).
- Validator tests for the like/just rule (dropped with another eligible word, kept when alone).
- Frequency measured before and after on the 34 dev clips with
  `.scratch/add-emojis/tools/emoji-coverage.ts --runs 3` (paths in the builder brief): Balanced stays
  ≈ 19/min (no lower than 17), no ordinary run under 10/min. Spot-check that "disagree" style lines no
  longer get the positive emoji (add a few fixtures to the eval).
- `bun run lint`, `bun run typecheck`, `bun run test` pass.
- ADR 0022 / spec mention the art-before-commit rule and the three prompt rules.

## Evidence (2026-11-27)

**Code.**
- `caption-emoji-runs.ts`: `CaptionEmojiRunRequest.loadArt` (required); the run awaits it for the answer's ids after
  `suggest` and before the live-source merge; a rejected load is caught and the answer still commits.
  `use-caption-emojis.ts` passes `preloadCaptionEmojiArt` (Regenerate, Add with AI and the AI tools row's Apply all go
  through `generate`).
- `emoji-glyph.tsx`: `EmojiGlyphPlaceholder` → `EmojiGlyphSpace`, an empty box of the glyph's size (no fill, no radius);
  the picker footer uses it. `emoji-picker-parts.tsx`: an unloaded cell is empty (the `data-placeholder` disc removed).
- Copy: Light "Fewer emojis, on the key words.", Balanced **"An emoji every few seconds."** (not "on most captions":
  Balanced keeps about 19 a minute, roughly 40% of the 4-word tagging lines and fewer of the on-screen cues, so "most"
  was not honest), Expressive "As many as fit, close together." Docs: AI tools → Add emojis → Emojis panel; "In this
  clip" and "Add to a word" replace "On screen now".
- `emoji-tagging.ts`: `like` / `just` lose their letter when the line has another eligible word (any language's
  speech; Hindi/Urdu lists unchanged). Three prompt rules added in one place (reversal words, discourse words,
  danger ≠ 💀).
- Eval: `en-reversal` script in `fixtures-negation.ts` (disagree, dislike, unhappy, impossible, unsafe, like, just,
  carbon monoxide, warning, agree), with no targets; read its picks in the report.

**Tests.** Runs: commits only after a fake loader resolves (state stays `running`, nothing replaced); a rejected
loader still commits. Glyph: server markup of an unloaded `EmojiGlyph` has no `<svg>` and its box has no background
or border-radius; an unloaded picker grid's 8 cells are empty. Validators: like/just dropped beside another word, kept
alone, the same in Urdu speech. `use-caption-emojis.test.tsx` warms the art cache before `generate`.
`bun run typecheck` passes. `bun test` in apps/web: 1540 pass, 0 fail. The turbo test run: every package passes
except one flaky `mcp-server` upload-session test (passed on rerun) and, on the last run, 19 `caption-scene` emoji
failures from ticket 33's edits in progress (3261/0 on the run before). `bun run lint` fails only on untracked
`.scratch/**` files from other sessions; Biome is clean on every file changed here.

**Coverage, 34 dev clips, `--runs 3`, before → after:**

| Set | L / B / E per minute | Lowest at B | Under 10/min at B | Lines with a candidate | $ / 1,000 words |
| --- | --- | --- | --- | --- | --- |
| all (102 runs) | 11.8 / 18.5 / 25.9 → 11.9 / 18.5 / 25.8 | 0.0 → 0.0 (`ur-7c9d-01`, the death clip) | 3 → 3 (same clip) | 92% → 92% | 0.0084 → 0.0086 |
| ordinary (99) | 12.2 / 19.1 / 26.6 → 12.3 / 19.0 / 26.6 | 12.6 (`en-0b07-00` r3) → 15.3 (`ur-7c9d-09` r3) | 0 → 0 | 94% → 95% | 0.0082 → 0.0084 |
| en / hi / ur at B | 19.5 / 20.5 / 18.2 → 19.4 / 21.1 / 18.0 | | | | |

Spot check, Balanced picks (1,161 → 1,157): on a discourse word (like, just, so, well, basically, actually, literally)
16 → 7, like/just alone 10 → 2 (both on lines where it is the only eligible word or beside "like,"); 💀 1 → 0 (it was on
"die" for a car, now ⚡); "carbon" (monoxide) ⚠️ ×6 → 💨/🧪/🚨; "disagree" 👎 in 2 of 3 runs → 1 of 3, never 🤝 before or
after at Balanced; 🤝 only on agree/deal/collaborated. Synthetic probe (12 lines, 5 runs per prompt): "dislike" line
anchored "really"/"update" 😑🔄 in 3 of 5 old runs → 👎 on "dislike" 5 of 5; "disagree"/"strongly" 👎 in both; no 💀 in
either; accepted 24.4 of 25 lines in both. The owner's 🤝-on-disagree was not reproduced on these clips with the old
prompt, so that rule rests on the probe and the eval fixture. Spend: about $0.23 at list price before cache discounts (two coverage runs $0.22, probe $0.01).

## Follow-up from the owner (2026-11-27, live Studio)

- **The picker jumped while typing**: opened above the chip ("Emoji on “they're”", Recent + Smileys), and the
  first typed letter moved it below the chip. Cause: `flip: true` with `fitViewport` re-decided the side on
  every layout pass while the content changed. Fix (`emoji-picker-host.tsx`): `emojiPickerPlacement` picks
  the side once per open (below if 414 px fit there, else above if they fit, else the roomier side), `flip:
  false`, and the popover has a fixed height (`EMOJI_PICKER_HEIGHT` 408 px, capped by the window); the grid
  fills it (`flex: 1 1 264px`), so the footer stays put. Tests in `emoji-picker-model.test.ts`.
- **Size S/M/L** (L smaller than M, S moved the emoji above): a placement bug, fixed in ticket 33's review
  round (side judged at the reference size; size steps L → M → S before the 0.7 shrink).

### Review fixes (2026-11-27, not committed)

- **A failed shard no longer blanks saved emojis until reload.** `loadCaptionEmojiArtSettled` (`packages/caption-emoji/src/art.ts`)
  also returns the ids whose shard failed; the Studio's session cache (`use-caption-emoji-art.ts`) answers only the
  others, so the hook's one retry after 3 s really asks again. An AI run still commits when the load fails.
  Tests: cache keeps a failed shard's ids pending and asks only for them; the retry loads them; `art-load.test.ts`
  reports `failed` and leaves unknown ids out of it.
- **Docs**: spec D5's "shows from the cue's start" sentence is now the quick-entrance rule (never before its word);
  ADR 0022's AI bullet names the three prompt rules in one sentence.
