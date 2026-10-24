# 12 - Recipes

**What to build:** Named, revisioned Workspace settings: Brand Profile, language, Content Pack settings, and finishing. Autopilot rules and integrations reference them, so one edit changes what new work uses, without changing work already accepted.

**Blocked by:** [04 - Finishing](04-finishing.md), [05 - Publishing Queue](05-publishing-queue.md).

**Status:** done

## Behavior

- Model `Recipe`:
  - `workspaceId`, `name`, `revision`, `brandProfileId` (nullable), `languageCode`, `contentPack` (validated with `contentPackSchema`), `finishing` (nullable, `finishingSettingsSchema`).
  - `createdByUserId`, `updatedByUserId`, `deletedAt`.
  - Edits bump `revision` with optimistic concurrency.
  - A Recipe referenced by an active rule can't be deleted.
- Autopilot rules reference a Recipe (`recipeId`, required) and lose their own `contentPack`, `languageCode`, `brandProfileId`, and `finishing`. Pre-production policy: no dual paths. The migration creates one Recipe per distinct existing rule setting and points rules at it.
- REST and MCP intake and generation accept `recipeId` as an alternative to inline settings; sending both is a validation error.
  - Resolve the Recipe after the receipt replay lookup.
  - Store the resolved Recipe ID and revision in the accepted result, as Brand Profile defaults do (`project.service.ts` near the default-profile comment).
  - Never put the revision in the fingerprint, so honest retries after an edit replay instead of conflicting.
- Browser intake: a "Recipe" picker prefills the existing setup form. What's submitted is still the explicit settings.
- REST: `GET /api/v1/recipes` and `GET /api/v1/recipes/{id}`; MCP `narriflow_list_recipes`. Writes stay in the browser.
- UI: a Recipes page (list, create, edit, duplicate, delete) in the app's design language, and the rule form picks a Recipe.
- Docs and GLOSSARY entry for **Recipe**.

## Acceptance criteria

- [x] Editing a Recipe changes the next Autopilot import, not past ones (DB test).
- [x] REST retry after a Recipe edit replays the original receipt (DB test).
- [x] `recipeId` plus inline settings is refused.
- [x] Migration moves existing rule settings into Recipes.
- [x] lint, typecheck, test, Autopilot and `test:integration-api:db` gates pass on the local Postgres.

## Comments

2026-10-24: implemented in a worktree, Opus-reviewed. Fixes from review: Recipes that propose to a queue need `publishing:write` from MCP callers; at run time a rule whose creator can't manage publishing ends finishing `partial` (`actor_lacks_publishing`), and saving such a Recipe warns; the migration cleans languages and packs the schema would refuse; upload open responses report the Recipe used; `ContentPack.recipe` records `{id, revision}` for audit. Integration with 08 added `Recipe.contentRevision`, bumped only by content edits (renames bump `revision` only), and `onRecipeContentChanged` pauses the standing grants that cover affected rules. Merged into dev; verified there: biome, typecheck, `bun run test`, worker (696), and every DB gate on the local Postgres (recipe and recipe-migration tests run in integration-api). UI not viewed in a real browser.
