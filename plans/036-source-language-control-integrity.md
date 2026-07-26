# Plan 036: Make the project language control truthful after transcription

> **Executor instructions**: Work in the shared current tree and touch only the
> scoped files. Preserve concurrent/user work; do not edit plans/index, stage,
> commit, push, or trigger a workflow.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plan 024
- **Category**: multilingual correctness, ux
- **Planned at**: commit `05d273d`, 2026-07-10, live working tree
- **Result**: DONE — reviewed 2026-07-10; scoped Biome/diff checks and full
  typecheck/tests/build passed (199 tests), and the authenticated completed
  project drawer was verified to expose no ignored language control.

## Why this matters

Project “Detection settings” always shows a `Language` select defaulted to
Auto. The initial transcription action reads it, but the regenerate-clips
action does not, and clip generation correctly uses the completed transcript's
detected language. After transcription, changing the visible selector is
therefore silently ignored. Before transcription, the Auto default can also
misrepresent a manual language stored during upload.

## Scope

- `apps/web/app/(app)/projects/[projectId]/advanced-clip-settings.tsx`
- `apps/web/app/(app)/projects/[projectId]/page.tsx`
- `packages/services/src/project.service.ts`
- a small colocated pure test only if a new helper warrants it

Do not modify transcript text/language, queue a new transcription, change the
worker prompt, or add a schema migration.

## Steps

1. Include the project's persisted source language in `ProjectSnapshot` and
   its in-memory/Prisma mapping with the existing nullable provider-code shape.
2. Give `AdvancedClipSettings` explicit props for whether source language is
   editable and its persisted default. Initial transcription settings show the
   provider-derived list and select the actual stored code (or Auto). Once a
   transcript is complete, regeneration settings must not present a control
   that the action ignores; hide it or show a clearly read-only transcript
   language label. Preserve all other settings and compact layout.
3. Pass the mode/default explicitly at every project-page call site. Do not
   infer editability inside the reusable component from missing props.
4. Verify source language remains present in the initial transcription form,
   absent/read-only in regenerate forms, and the worker continues to consume
   `Transcript.languageCode`. Run scoped Biome plus full typecheck/tests/build.

## Done criteria

- [x] No post-transcription language selector silently accepts ignored changes.
- [x] Manual upload language is reflected accurately before transcription.
- [x] Regenerated clips preserve the completed transcript language.
- [x] Existing form actions and all release gates pass.

## STOP conditions

- A correct fix requires changing the stored transcript language or
  retranscribing existing media.
- Project snapshots cannot expose the already-persisted language without a
  migration.
- A gate fails twice after one reasonable correction.
