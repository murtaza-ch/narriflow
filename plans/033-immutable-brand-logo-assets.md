# Plan 033: Preserve brand-logo assets referenced by copies and project snapshots

> **Executor instructions**: Work directly in the shared current tree. Touch
> only the scoped files, do not stage/commit/push, and do not edit this plan or
> its index. Preserve all concurrent/user changes.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: —
- **Category**: data integrity, media lifecycle
- **Planned at**: commit `05d273d`, 2026-07-09, live working tree
- **Result**: DONE — reviewed 2026-07-10; confirmed the render worker consumes
  `brandSnapshot.logoStorageKey`, eager deletion is gone, scoped Biome and the
  executor's full typecheck/tests/build passed.

## Why this matters

`BrandTemplateService.duplicate()` reuses the source `logoStorageKey`, while
`update()` and `softDelete()` delete that object immediately. Deleting either
copy therefore breaks the other. More importantly, project `brandSnapshot`
JSON deliberately freezes the same logo key for later renders, so deleting or
replacing a template can silently remove an asset needed by an existing
project. A duplicate of a built-in template can also point at a shared built-in
asset and currently acquire a deletion path for it.

## Scope

Only modify:

- `packages/services/src/brand-template.service.ts`
- `README.md` (one concise lifecycle note if needed)

No schema, migration, manifest, lockfile, UI, upload contract, or destructive
storage sweep changes.

## Steps

1. Treat logo keys already attached to a template or snapshot as immutable,
   shared media references. Remove the eager R2 deletion side effects from
   template update and soft-delete. Remove the now-unused `deleteObject`
   import. Do not copy the object during duplication and do not weaken the
   existing owned-key check for newly supplied custom logo keys.
2. Add a clear maintenance comment explaining why replacement/deletion retains
   the old object: duplicates and project snapshots may still reference it.
   State that a future storage GC must inventory live template and snapshot
   references before deletion. Do not claim retention cleanup exists.
3. Verify:
   - `rg -n 'deleteObject' packages/services/src/brand-template.service.ts`
     returns no matches.
   - `bunx biome check packages/services/src/brand-template.service.ts`
   - `bun run typecheck`
   - `bun run test`
   - `bun run build`

## Done criteria

- [x] Replacing/deleting one template cannot remove a logo used by a duplicate.
- [x] Existing project snapshots retain a valid logo key after template changes.
- [x] New custom keys remain tenant-prefix validated.
- [x] Full gates pass and no out-of-scope file changes.

## STOP conditions

- A correct change would require deleting/copying existing production R2 data.
- The current render path does not in fact consume snapshot logo keys.
- A gate fails twice after one reasonable correction.

## Maintenance note

Add a separate, dry-run-first storage GC after Plan 030 defines retention. It
must scan active/deleted templates plus every persisted project snapshot and
use a grace period before deleting any unreferenced logo object.
