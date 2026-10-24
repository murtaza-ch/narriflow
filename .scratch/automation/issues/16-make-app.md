# 16 - Make custom app

**What to build:** A Make custom app definition for Narriflow that mirrors the Zapier app's triggers, actions, and searches, ready for the owner to import with Make's app tooling.

**Blocked by:** [07 - Zapier integration](07-zapier-app-and-n8n-template.md).

**Status:** done

## Behavior

- `integrations/make/` holds the app definition in the format Make's Apps SDK and VS Code extension use. It includes the base (URL, auth header, error handling), the API key connection with a test call, modules, and RPCs. Excluded from repo lint and typecheck like the Zapier app.
- Modules:
  - A polling trigger: Watch events by type, with `seq` as the cursor and `id` as the dedupe key.
  - Actions: Submit Video Link, Generate Clips, Export Clip, Propose Social Post.
  - Searches: Get Export Download.
  - An RPC listing Brand Profiles and Social Accounts for dropdowns.
- Idempotency keys come from stable bundle inputs.
- README with import and private-sharing steps (owner) and the public review constraints from the map.
- Docs page in `apps/web/content/docs`.

## Acceptance criteria

- [x] JSON files parse and follow Make's documented structure (checked against the current Make developer docs).
- [x] No secrets in the definition.
- [x] Repo-wide lint and typecheck unaffected.

## Comments

2026-10-24: implemented in a worktree, Opus-reviewed (no blocking issues). Fixes from review: an empty cursor is omitted rather than sent as `after=`; the "Choose where to start" panel explicitly drops the inherited cursor so it can't combine `after` with `order=desc`; pagination stops on a short page; 403 is an `InvalidConfigurationError` so a missing permission stops the scenario; Run Keys are trimmed like Zapier's. The trigger reads `order=asc` from the `seq` cursor (the API's `desc` mode has no cursor). Merged; verified in the main checkout: `node --test integrations/make/test/*.test.mjs` (13), biome, typecheck; Make CI job added. Owner steps: import with Make's app tooling, then one Make DevTool run of Submit Video Link with Finishing left empty (confirms `join`/`ifempty` on empty fields in Make's runtime).
