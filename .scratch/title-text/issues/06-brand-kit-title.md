# 06 - Brand kit: Title section on the template form

**What to build:** A brand template's form has a Title section: on/off switch, display duration, and the title style with a live sample.

**Blocked by:** [04 - Text panel, timeline lane, Apply to all clips](04-text-panel-timeline.md), [05 - Auto title and persistence](05-auto-title-and-persistence.md)

**Status:** done (2026-11-27)

Read `../spec.md` section 7 and `apps/web/app/(app)/brand-kit/_components/template-form.tsx`.

## Scope

- Title section next to the caption style section, clearly labelled apart from it: switch "Add the clip title to new clips", display duration (3 s, 5 s, 10 s, whole clip, custom seconds), `TextStyleControls`, position (top, middle, bottom as a simple choice mapped to `positionY`), and a live sample drawn by the real painter on the form's preview frame.
- Switching the title off keeps its style and duration. A template without `title` shows the built-in default.
- Saved through the existing template create and update mutations.

## Acceptance

- [x] Saving a template with a changed title style, reloading the form, shows the saved style.
- [x] A project created with that template seeds titles in that style (covered by ticket 05 tests; check the wiring by reading).
- [x] `bun run lint`, `bun run typecheck`, `bun run test`, `bun run check:web-split` pass.

## Evidence (2026-11-27)

Branch `feat/title-text-brandkit` (from `feat/title-text` 806635411).

- Title section (`brand-kit/_components/title-settings.tsx`, mounted in `template-form.tsx` after Colors): its own panel "Title" with a one-line note that it is separate from captions; the caption panels are renamed "Caption look" and "Caption text" so the two read apart. Switch "Add the clip title to new clips"; Show for 3 s / 5 s / 10 s / Whole clip / Custom (Custom shows a seconds field, 1-600); Position Top / Middle / Bottom = positionY 12 / 50 / 80, with a "Custom" option only when the stored value is something else (it stays one tap away after picking another); the shared `TextStyleControls` under "Title style". Off hides the controls and says the style, timing and position are kept; the stored settings are untouched (`enabled: false`).
- Form state keeps `title: null` (the built-in default) until the first title change, so an untouched template still saves null and keeps following `DEFAULT_BRAND_TITLE`. Saved through the existing create and update mutations (the form sends `title` with the rest of the input).
- Live sample: `TextLayerFramePreview` (new, `text-layer-sample.tsx`) draws the title layer a new clip would get (`titlePreviewLayer`) with the real painter at 1080×1920 on the form's phone preview, at its position and in its style, over the caption sample; nothing while the title is off. The caption line under the preview adds "with title".
- Shared controls on the app's surfaces: `TextStyleControls` drew only with the Studio's graphite `studio.*` tokens (portaled menus and picker included). It now reads its tokens from a tone; `TextControlsAppTone` switches the controls inside it to the app's own tokens (soft fields, `bg.raised` dropdown with the theme's hairline, accent toggles, the ui Slider's track and thumb), light and dark. The Studio keeps the default tone, with the same token values as before.
- Acceptance 2 (by reading): the update route writes `title` whenever it is sent; `brandTemplateSnapshot()` carries it into the project's brand snapshot; `prepareDetectedClipSeed` reads it from `project.brandSnapshot` (ticket 05 tests).
- Tests: `template-form.test.ts` runs `template-form.browser.fixture.tsx` (happy-dom, real form, real controls; painter and caption sample stubbed because happy-dom has no 2D canvas), 6 tests: the default shows for a template without `title`; an untouched title saves null; a changed style, position and duration is saved through the update mutation and shows again after remounting with the saved template; off keeps style and duration and the preview draws no title; custom seconds and a stored position; create mode saves through the create mutation.
- Screenshots (`brandkit/`, temporary prototype route on mock data, deleted): `form-default-dark.png` (no stored title: built-in default), `form-custom-dark.png` and `form-custom-light.png` (custom seconds, bottom, yellow italic Montserrat with stroke and shadow), `form-off-dark.png`, `menu-font-light.png` and `picker-colour-light.png` (portaled font menu and colour picker in the app tone, opened over CDP).

Studio follow-up ("Add a title" from the project's brand title):
- `studioQueries(...).brandSnapshot(projectId)` in `packages/api-client/src/studio/queries.ts`: a `queryOptions` for the existing `GET /projects/:id/brand-snapshot`, keyed under `studio/brand-snapshot` (the prefix `invalidateBrand` already marked stale). No query for it existed, only the invalidation key.
- `useProjectBrandTitle(projectId)` (`studio/_components/project-brand-title.ts`): `brandTitleOrDefault(snapshot.title)`, the default while loading, on failure, or with no snapshot. `useTextLayerCommands` passes it to `newTitleLayer`, so "Add a title" (and a preset card that adds a title) takes the brand placement, width, duration and style.
- Tests: `studio-text-layers.test.tsx` (brand settings used; default without them), `brand.test.ts` (the query hits the route and a brand edit invalidates it).

- Verification: `bun run lint` (0 errors; 20 warnings, all in files this ticket does not touch), `bun run check:web-split` (passed), `bun run typecheck` (17/17), `bun run test`: web 1496 pass / 0 fail, api-client 243 pass / 0 fail, every other package green except `@narriflow/media` 1250 pass / 2 fail. The two media failures ("pinned environment > the fingerprint records … the model hash" and "a baseline taken with another face model is refused") compare this worktree's local face-model file hash with the lock file; nothing in `apps/media` or anything it imports changed here.
