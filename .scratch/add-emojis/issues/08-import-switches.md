# 08 - Add emojis switch at import (web)

**What to build:** An "Add emojis" switch wherever the web app collects generation settings.
Rules: [../RULES.md](../RULES.md). Spec D9.

**Blocked by:** [03 - Import option](03-import-option.md)

**Status:** done

## Areas

`apps/web/app/(app)/upload/**`, `apps/web/app/(app)/recipes/**`,
`apps/web/app/(app)/projects/[projectId]/advanced-clip-settings.tsx`, and their tests. Not the
Studio.

## Follow the existing toggle

`removeFillerWords` is the precedent. Add `addEmojis` at every step it appears:

- `upload/_components/clip-style-settings.tsx` (prop types, destructuring, the switch rows array
  with `{id, name, icon, title, hint, checked, onChange}`). Title: "Add emojis". Hint: one short
  line, for example "AI adds emojis that match what is said". Pick an icon from the set the file
  already uses. Place it with the caption-related rows, not the cleanup rows.
- File flow: `upload-shell.tsx` (state, form values, recipe prefill, `buildUploadGenerationContext`).
- Link flow: `configure-step.tsx`, `link-content-pack.ts`, `link-import-flow.tsx` (resume),
  `upload/_lib/recipe-settings.ts`.
- Form codec: `upload/_lib/content-pack-form.ts` (default, read, type, FormData, context builder).
- Regenerate form: `projects/[projectId]/advanced-clip-settings.tsx`.
- Recipes: `recipes/recipe-form.ts`, `recipes-panel.tsx`.

Default off. No plan gate.

## Acceptance

- [x] The switch appears in the upload form, the link import step, the Recipe form and the
      regenerate form, and its value reaches the request body in each (tests on the codecs and
      builders, as the existing toggles have).
- [x] Resuming a link import and applying a Recipe restore the switch.
- [x] `bun run lint`, `bun run typecheck`, web tests, `bun run check:web-split` (repository-wide
      lint and typecheck fail only in files other tickets own; see Evidence).

## Evidence

Implemented 2026-11-26.

### Where the switch sits

- Upload form and link Configure step (`clip-style-settings.tsx`): first switch row, directly
  under the caption style gallery, icon `Smile` (lucide, the icon the Studio already uses for
  emojis). Title "Add emojis", hint "AI adds emojis that match what is said". The row shows in
  both modes; in caption-only mode it is the only row, above the "Your full video will be
  transcribed" note. Hook, silences and filler rows stay clip-only as before.
- Regenerate drawer (`advanced-clip-settings.tsx`): a `ToggleCard` right under the caption style
  gallery, outside the clip-only sections; posted as a hidden `addEmojis` field that
  `readContentPackFromForm` reads.
- Recipe dialog (`recipes-panel.tsx`): first toggle in the Clips section (the dialog has no caption
  style control); Recipe cards show an "Emojis" chip when it is on.
- Default off everywhere. No plan gate.

### Data path

- `content-pack-form.ts`: `UploadSettingsFormInput.addEmojis`, written to FormData, read with
  `readBoolean(formData, "addEmojis", false)`.
- `link-content-pack.ts`: `LinkConfigureState.addEmojis`, `buildLinkContentPack`, default state,
  and the resume mapper moved here from `link-import-flow.tsx` as
  `linkConfigureStateFromContentPack` so it can be tested.
- `recipe-settings.ts` fills `clip.addEmojis`; `upload-shell.tsx` (`applyRecipe`, `getFormValues`)
  and the link flow (`onRecipeApplied` spreads `clip`) pick it up.
- `recipe-form.ts`: draft field, empty draft, `draftFromRecipe`, `recipeFromDraft`.

### Tests

- `upload/_lib/content-pack-form.test.ts`: default off, travels through `buildUploadGenerationContext`,
  empty FormData reads false, a hidden `"true"` (regenerate form) reads true.
- `upload/_lib/link-content-pack.test.ts` (new): default off, reaches the submitted pack, a resumed
  pack reopens with the same state and rebuilds the same pack, a Recipe fills it into the step.
- `upload/_lib/recipe-settings.test.ts`: Recipe → form settings → submitted pack carries `addEmojis`.
- `recipes/recipe-form.test.ts`: blank form saves false; draft opens from a Recipe with it on,
  turning it off saves false and counts as a change; a new Recipe can save it on.

### Commands

- `bun test "app/(app)/upload/_lib" "app/(app)/recipes"` (in apps/web): 115 pass, 0 fail.
- `bun run --cwd apps/web test`: 1257 pass, 0 fail across 168 files.
- `bun run --cwd apps/web typecheck`: clean.
- `bun run check:web-split`: passed (no build present, bundle not scanned).
- `bunx biome check` on the upload, recipes and advanced-clip-settings files: 64 files, clean.
- `bun run lint`: 168 errors, none in this ticket's files (all in `.scratch/**`,
  `hero-experience.module.css`, `landing.css`, `caption-presets.prototype.html`,
  `narriflow-emoji-prototype.html`).
- `bun run typecheck`: 10/11 tasks; `@narriflow/services` fails at
  `src/clip-selection-preparation.ts(80,7)` (`emojiPicks` missing on `DetectedClipSeed`), ticket
  05's work in progress. Re-ran after a few minutes with the same result.

### Browser check

Not done. The running dev server on :3000 redirects `/upload` to sign-in (307 to
`/?auth=sign-in`), so the form is not reachable without credentials.
