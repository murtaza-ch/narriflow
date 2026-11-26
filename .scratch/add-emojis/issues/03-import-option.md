# 03 - Import option `addEmojis` (schema, database, REST, MCP, Recipes)

**What to build:** `addEmojis` as a generation setting everywhere a project can be created, stored
on the Content Pack. No behaviour yet (ticket 05 acts on it); no web UI (ticket 08). Rules:
[../RULES.md](../RULES.md). Spec D7.

**Blocked by:** [02 - Contracts and plan](02-contracts-and-plan.md)

**Status:** done

## Areas

`packages/validators` (content pack, integration, REST, MCP, recipe schemas), `packages/db`
(schema and one migration file), `packages/services` where the pack is built or copied,
`apps/api` REST snapshots, `apps/mcp`, `packages/api-client` OpenAPI document,
`apps/web/content/docs/api/uploads.mdx`. Not `apps/web` components.

## Follow the existing toggle

`removeFillerWords` is the precedent; add `addEmojis` beside it at every step:

- `packages/validators/src/content-pack.ts` (`contentPackSchema`: `addEmojis: z.boolean().default(false)`),
  and every schema that reuses or mirrors it: `api/ingest.ts`, `upload.ts`, `clip.ts`
  (`regenerateClipsRequestSchema`), `recipe.ts`, `clip-selection.ts` (the frozen selection input:
  check whether adding a key to the pack changes the selection input hash for runs in flight and
  say what you found; pre-production policy means no compatibility code).
- `packages/validators/src/integration.ts` (`generationSettingsSchema` is strict;
  `buildGenerationContentPack`), `mcp.ts`, `rest-api.ts`; `apps/mcp/src/upload.ts`;
  `packages/services/src/integration-commands.ts`.
- `packages/db/prisma/schema.prisma` `ContentPack.addEmojis Boolean @default(false)` and a
  migration file modelled on `migrations/20261112000000_clip_cleanup/migration.sql`. Run
  `bun run --cwd packages/db prisma:generate`. **Do not apply the migration to any database.**
- `packages/services`: wherever a pack is stored or copied (`project.service.ts` `storedPackData`
  and the `contentPack.create` sites, `upload-session.service.ts`), confirm the new key flows
  through; add it explicitly where fields are listed one by one.
- Regenerate OpenAPI: `bun run --cwd apps/api openapi:generate`, then `openapi:check`. Update the
  REST and ingest snapshots and tests that list generation settings.
- Docs: add the row to the "Generation settings" table in `apps/web/content/docs/api/uploads.mdx`.
- Zapier and Make integrations do not list the cleanup toggles today; leave them.

## Acceptance

- [x] A pack with `addEmojis: true` round-trips through each schema and through the REST and MCP
      builders (tests).
- [x] Old stored Recipes without the key parse (default false) (test).
- [x] `bun run lint`, `bun run typecheck`, `bun run test`,
      `bun run --cwd apps/api openapi:check`, `bun run --cwd apps/api test:inventory`.
- [x] The migration SQL is in Evidence, with a note that it is not applied.

## Evidence

Implemented 2026-11-26.

### Migration (written by hand, NOT applied to any database)

`packages/db/prisma/migrations/20261126120000_content_pack_add_emojis/migration.sql`:

```sql
-- AI caption emojis chosen at generation.
ALTER TABLE "ContentPack" ADD COLUMN "addEmojis" BOOLEAN NOT NULL DEFAULT false;
```

It must be applied (`prisma:migrate:deploy`) before any code that writes a Content Pack is deployed,
because every create site spreads the parsed pack into Prisma.

### Selection input hash (frozen capsules in flight)

The workflow run's `inputHash` (`workflow-execution-input.ts`) covers `contentPackId`, not the
pack. The selection capsule's `selectionHash` is the SHA-256 of the bytes frozen at preparation;
`decodeClipSelectionInput` checks the hash against the stored bytes before
`clipSelectionInputSchema.parse` fills `addEmojis: false` (and, since ticket 13,
`editor.emojiPicks: null`), so finalization of an old capsule decodes. Corrected by ticket 13: a
decoded capsule is re-encoded on restore (`execution-selection-restore.ts` compares the re-encoded
hash with the stored `selectionHash`), and the filled-in defaults change those bytes, so restoring a
capsule prepared before this change refuses. Deploy note: no selection may be in flight at deploy.
No compatibility code added.

### Pack create sites

`project.service.ts` (`storedPackData`, both link intake creates, generate/draft), `upload-session.service.ts`,
`workflow-run-lifecycle.ts` all spread the parsed pack, so the key flows through with no edit. The
only one-by-one field list was `recipeView` in `integration-commands.ts` (edited).

### Commands

- `bun run --cwd packages/db prisma:generate`: ok; generated `index.d.ts` has 41 `addEmojis` hits.
- `bun run --cwd apps/api openapi:generate` then `openapi:check`: "Public OpenAPI artifact matches all 32 REST operations" (+10 lines, `GenerationSettings` and the inline recipe view).
- `bun run --cwd apps/api test:inventory`: 301 routes, 0 problems.
- `bun run typecheck`: 17/17 tasks successful (after the one web default, below).
- `bun run test`: 16/16 tasks successful, no failures.
- `bun test packages/validators/src/content-pack.test.ts`: 10 pass (4 new); `apps/mcp/src/upload.test.ts`: 7 pass (1 new); REST `app.test.ts` + `upload-session-http.test.ts`: all pass (2 new), OpenAPI snapshot updated.
- `bunx biome check` on every file I touched: clean. `bun run lint`: errors only in `.scratch/**` and the other known files, none in mine.

### Outside the ticket's areas

- `apps/web/app/(app)/upload/_lib/content-pack-form.ts`: the hand-built `defaultContentPack: ContentPack`
  gained `addEmojis: false` so web typechecks. No UI (ticket 08 wires the switch).
