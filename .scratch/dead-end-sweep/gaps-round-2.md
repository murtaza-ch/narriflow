# Dead-end gaps — round 2 (2026-10-27)

Follow-up to `rules.md` in this folder (read it first: cause → treatment table, owner taste, constraints).
The owner approved one recommended approach per gap. Four workers run in parallel with disjoint file ownership.

## Owner decisions (settled — do not re-litigate)

1. **Brand profile delete → "Replace with" dialog.** The delete dialog shows what uses the profile
   (workspace/personal default, Recipes by name/count). User picks a replacement profile or "No brand profile".
   The server honors `replacementProfileId` (already in `brandProfileSoftDeleteSchema`) in the same transaction:
   moves the default and every Recipe pointing at the deleted profile. Delete works on every profile, including
   the default. Projects keep their brand snapshot (untouched).
2. **Brand kit Style presets** get an "Add style" picker (workspace styles; "Create a style" when none) plus
   remove; uses the existing `PUT /brand-profiles/:id/membership` API (kind `template`).
3. **Brand audio is made real.** Audio references can be attached/removed on the profile page (membership kind
   `audio`). A profile's music becomes the default background music for clips using that brand; its sound
   effects are offered first in Studio.
4. **Studio "Save needs attention"** becomes a clickable status that opens a small panel: the reason + one primary
   action, local edits always kept. Causes: semantic rejection (show real reason from the code; upgrade when a plan
   lifts it, else "Undo last change"/"Load last saved version"), authentication lost ("Sign in again" in new tab,
   then retry), clip missing ("Back to project"), revision conflict ("Load latest"/"Keep mine").
5. **Social post actions respect role**: server filters `allowedActions` by the requesting member's capabilities.
   Viewers get none; editors never get `reconnect_account` (needs `social.manage`) — show "Ask an owner or admin to
   reconnect this account" instead.
6. **Clip boundaries PATCH** (`set_boundaries`, used by the project page "Edit clip length" dialog) goes through the
   same editor reducer path as the Studio (`applyEditorAction` → `setClipBoundaries` in
   `packages/validators/src/editor-document.ts`), so Scenes/text/SFX/whole-clip motion move with the footage.
7. **Deleted B-roll asset**: a save rejected because a placed asset was deleted gets "A B-roll image was deleted"
   + "Remove it". The "asset is in use" delete refusal names where it's used (clips/templates/profiles).

## Common constraints

- Pre-production policy (AGENTS.md): no compatibility layers; remove dead paths.
- Validators for schemas; services hold business logic; structured logs per AGENTS.md.
- Stay in your owned paths; re-read before editing — others edit in parallel. Don't commit.
- Verify: focused tests + relevant DB gate(s) against local Postgres:
  `DATABASE_URL='postgresql://postgres@localhost:55432/postgres?host=/tmp/nfpg' DIRECT_URL='postgresql://postgres@localhost:55432/postgres?host=/tmp/nfpg' bun run test:<name>:db`
  (never the shared Neon DB), then `bun run lint`, `bun run typecheck`, `bun run test` from repo root.
  If a schema migration is needed, add it under `packages/db/prisma/migrations` and apply ONLY to local Postgres;
  say so in the report (owner applies to the shared DB).
- Report: files changed, behavior before → after, tests added/run with results, anything deliberately left.
