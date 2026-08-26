# Establish Brand Profile and Visual Asset ownership

**What to build:** Add the durable Brand Profile, Visual Asset, Brand Font, and profile-membership contracts without changing current Brand Template behavior.

**Blocked by:** None. This is a frontier ticket.

**Status:** ready-for-agent

**Specifications:** [Program map](../spec.md), [Brand profiles and asset library](../features/brand-profiles-and-assets.md)

## Observable acceptance criteria

- [ ] Prisma models and additive migrations represent profiles, image or video assets, fonts, template membership, asset membership, font roles, and references to existing Audio Assets.
- [ ] `Project.brandProfileId` is nullable and current `brandTemplateId` plus `brandSnapshot` behavior is unchanged.
- [ ] Shared validators define create, update, upload, finalize, list, membership, voice guidance, and soft-delete inputs.
- [ ] Services enforce owner scope, `brand.manage`, R2 key prefixes, media probing, font parsing, license confirmation, fingerprint deduplication, and reference-aware deletion.
- [ ] Stored records contain durable object keys and fingerprints, never signed URLs.
- [ ] New services are re-exported from `packages/services/src/index.ts`.

## Tests and failure injection

- [ ] Database tests cover workspace and personal ownership, duplicate fingerprints, cross-tenant IDs, built-in templates, soft deletion, live references, and concurrent updates.
- [ ] Storage tests inject missing objects, MIME mismatch, byte-size mismatch, malformed fonts, probe failure, and upload-finalize replay.
- [ ] Tests prove old project and Brand Template reads require no new rows.

## Migration and rollout

- [ ] Deploy nullable schema before writers and keep all new mutation routes disabled.
- [ ] Readers tolerate missing profiles and assets.
- [ ] Rollback disables new writes and leaves additive rows intact.

## Scope boundaries

- [ ] Do not backfill templates or change Brand Kit UI in this ticket.
- [ ] Do not migrate Audio Asset storage.
- [ ] Do not change Studio or render resolution yet.

## Fresh-task handoff

Implement with `/tdd`, finish with `/code-review`, and run focused validator, service, database, and storage tests plus `bun run typecheck` and `bun run test`.

