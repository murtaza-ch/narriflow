# 05 - Auto title, brand template persistence, Apply-to-all persistence

**What to build:** Newly generated clips carry a title layer from the project's brand title settings; brand templates store those settings; Apply to all clips writes titles on every clip.

**Blocked by:** [01 - Text Layer model and shared layout](01-model-and-layout.md)

**Status:** done

Read `../spec.md` sections 2, 3 and 7. No PostgreSQL gates exist for this (AGENTS.md): review every Postgres-facing change closely and keep database test files typechecking without running them.

## Scope

- Migration: nullable JSON `title` on `BrandTemplate` (`packages/db/prisma`). Do not apply it; the orchestrator applies it at deploy.
- `brand-template.service.ts`: `title` through `toSummary`, `buildSnapshot`, `create`, `update`, `duplicate` (`Prisma.DbNull` for null). `brand-profile.service.ts`: use `brandTemplateService.buildSnapshot` instead of its own `templateSnapshot()` so campaign comparisons do not drift. API routes and the api-client brand domain carry the field; new web treats a missing `title` as the default.
- Seeding (`clip-detection-persistence.ts`): `prepareDetectedClipSeed` carries the brand title settings from `project.brandSnapshot`; `clipStudioEdits` is restructured (it returns early today when there are no emoji picks) and adds the layer with the fixed id `"title"`. Duration clamps to the clip's edited duration after silence and filler cleanup. Rules for who gets a title are in spec section 2. `clip-selection.ts` capsule field from ticket 01 is populated here.
- Apply-to-all (`clip-editor-document-persistence.ts`): a dedicated merge for the `title` branch (it is not a `studioEdits` key and would be dropped silently by the generic merge); `title` and `hookText` on `ClipEditorDocumentStoredState`, `decodePrismaState` and the in-memory test store; skip clips at the layer limit or without usable text; clamp timing per clip; return updated, created and skipped counts; render invalidation and `excludeClipId` as the other branches. Route `POST .../clips/apply-studio-edits` returns the counts; admission declaration unchanged unless the route changes.
- Tests: seed with and without a brand title, off switch, caption-only, blank title, long title cut, short clip clamp, seed hash stable across two runs; Apply-to-all restyle, create, skip at limit, skip without text, clamp, `excludeClipId`; brand template round trip of `title` through summary, snapshot and duplicate.

## Acceptance

- [x] Two runs of `prepareDetectedClipSeed` on the same input produce equal seeds (no random id).
- [x] An Apply-to-all title patch changes other clips' documents (not `updated: 0`).
- [x] `bun run lint`, `bun run typecheck`, `bun run test`, `bun run --cwd apps/api test:inventory`, `bun run --cwd apps/api openapi:check`, `bun run --cwd apps/api build:worker` pass.

## Evidence (2026-11-27)

Branch `feat/title-text-services` (from `feat/title-text-core` 3f1e23756): 7b70caa8f (brand template title), 3f68475d3 (auto title seed), 6e0322887 (Apply to all title merge).

- Migration `20261127120000_brand_template_title`: `ALTER TABLE "BrandTemplate" ADD COLUMN "title" JSONB;` Not applied anywhere. `apps/api/src/generated/database-migrations.json` regenerated; `migrations:check` passes.
- Brand template: `brandTemplateSnapshot()` in `brand-template.service.ts` is the one snapshot builder (parsed through `brandTemplateSnapshotSchema`); `buildSnapshot` and the Brand Profile `style` both use it. `toSummary`, `create`, `update` (only when `title` is sent), `duplicate` carry it; null is written as `Prisma.DbNull`. Tests: `packages/services/src/brand-template-title.test.ts` (round trip through create, update, summary, snapshot and duplicate; null as SQL NULL; profile style JSON equals project snapshot JSON).
- Seed: `prepareDetectedClipSeed` carries `title` from `project.brandSnapshot` (`safeParse`, unreadable = null = default); `clipStudioEdits` adds the "title" layer per clip from the title, else hook text, clamped to the edited duration (`buildClipCutPlan`). Tests: `packages/services/src/clip-detection-title.test.ts`, 10 pass (default, unreadable snapshot, brand settings, off switch, caption-only, blank title to hook text, long title cut, clamp and null duration, silence cleanup, seed equality with brand music and capsule fit).
- Found and fixed: `seedBrandMusic` put `crypto.randomUUID()` into the hashed seed, so a project whose brand profile had music could never pass the final capsule hash check. The seed now uses the fixed block id `"brand-music"` (block ids only need to be unique within one clip).
- Apply to all: `applyTitlePatch` in `clip-title-text.ts`; persistence counts restyled/created only when the document changed, skipped for the layer limit, no words, or a failed canonicalize, never failing other clips. Route returns `{ updated, field: "title", title: { restyled, created, skipped } }` whenever the patches carry a title. Tests: `clip-editor-document-persistence.test.ts` "Apply to all clips: title", 4 pass.
- Verification: `bun run lint` (0 errors; 20 warnings, all in files this ticket does not touch), `bun run typecheck -- --force` (17/17), `bun run test` (16/16 tasks, 0 fail), `test:inventory` (302 routes, 0 problems), `openapi:check` (32 operations match), `build:worker` (audit passed).
