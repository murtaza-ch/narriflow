# 05 - Auto title, brand template persistence, Apply-to-all persistence

**What to build:** Newly generated clips carry a title layer from the project's brand title settings; brand templates store those settings; Apply to all clips writes titles on every clip.

**Blocked by:** [01 - Text Layer model and shared layout](01-model-and-layout.md)

**Status:** ready-for-agent

Read `../spec.md` sections 2, 3 and 7. No PostgreSQL gates exist for this (AGENTS.md): review every Postgres-facing change closely and keep database test files typechecking without running them.

## Scope

- Migration: nullable JSON `title` on `BrandTemplate` (`packages/db/prisma`). Do not apply it; the orchestrator applies it at deploy.
- `brand-template.service.ts`: `title` through `toSummary`, `buildSnapshot`, `create`, `update`, `duplicate` (`Prisma.DbNull` for null). `brand-profile.service.ts`: use `brandTemplateService.buildSnapshot` instead of its own `templateSnapshot()` so campaign comparisons do not drift. API routes and the api-client brand domain carry the field; new web treats a missing `title` as the default.
- Seeding (`clip-detection-persistence.ts`): `prepareDetectedClipSeed` carries the brand title settings from `project.brandSnapshot`; `clipStudioEdits` is restructured (it returns early today when there are no emoji picks) and adds the layer with the fixed id `"title"`. Duration clamps to the clip's edited duration after silence and filler cleanup. Rules for who gets a title are in spec section 2. `clip-selection.ts` capsule field from ticket 01 is populated here.
- Apply-to-all (`clip-editor-document-persistence.ts`): a dedicated merge for the `title` branch (it is not a `studioEdits` key and would be dropped silently by the generic merge); `title` and `hookText` on `ClipEditorDocumentStoredState`, `decodePrismaState` and the in-memory test store; skip clips at the layer limit or without usable text; clamp timing per clip; return updated, created and skipped counts; render invalidation and `excludeClipId` as the other branches. Route `POST .../clips/apply-studio-edits` returns the counts; admission declaration unchanged unless the route changes.
- Tests: seed with and without a brand title, off switch, caption-only, blank title, long title cut, short clip clamp, seed hash stable across two runs; Apply-to-all restyle, create, skip at limit, skip without text, clamp, `excludeClipId`; brand template round trip of `title` through summary, snapshot and duplicate.

## Acceptance

- [ ] Two runs of `prepareDetectedClipSeed` on the same input produce equal seeds (no random id).
- [ ] An Apply-to-all title patch changes other clips' documents (not `updated: 0`).
- [ ] `bun run lint`, `bun run typecheck`, `bun run test`, `bun run --cwd apps/api test:inventory`, `bun run --cwd apps/api openapi:check`, `bun run --cwd apps/api build:worker` pass.
