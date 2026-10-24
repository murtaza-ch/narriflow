# 01 - Apply Brand Profiles to RSS imports and make Autopilot ownership explicit

**What to build:** Every RSS Project, manual or Autopilot, carries a Brand Profile snapshot exactly as link intake does, so the brand's logo, fonts, scenes, writing guidance, and approval rule apply. An Autopilot rule whose acting member can no longer act pauses with a visible reason, and a Workspace Owner or Admin can take it over.

**Blocked by:** None.

**Status:** done

**Map:** [Automation and integrations map](../map.md), Verified defects 1 and 2.

## Behavior

### Brand Profiles on RSS intake

- `AutopilotRule` replaces `brandTemplateId` with `brandProfileId` (nullable UUID, FK to `BrandProfile`, `onDelete: SetNull`). Remove the old column and every read and write of it (pre-production policy: no dual paths). The migration backfills `brandProfileId` from the Workspace's `defaultBrandProfileId` for existing rules.
- Two states only. A stored ID means "this profile". `null` means "no Brand Profile". When a create request omits the field, the rule stores the Workspace default resolved at save time (the same rule as integration intake, `packages/services/src/project.service.ts:1217`). An explicit `null` stores none. Later changes to the Workspace default don't move existing rules.
- `rssImportSchema` (`packages/validators/src/ingest.ts`) replaces `brandTemplateId` with `brandProfileId` (`uuid | null`, optional). Browser RSS intake always sends the field, as link intake does. Omitted on an integration mutation means the Workspace default.
- `importResolvedRssEpisodes` resolves the profile with `brandProfileService.resolveForProject` and writes `brandProfileId`, `brandProfileSnapshot`, `brandTemplateId`, and `brandSnapshot` the same way link intake does (`project.service.ts:1286` to `:1297`). Factor the shared resolution into one helper used by both paths rather than copying it.
- If the selected profile can't be applied (plan, rollout switch, deleted profile), the import is refused, never done without the brand. For Autopilot this pauses the rule (see below) with a reason naming the Brand Profile and what to do. A brand with `approval_required` must never produce a Project with a null Brand Profile snapshot.

### Autopilot ownership

- A rule acts as `createdByUserId`. Rename nothing, but treat it as the rule's acting member.
- When the acting member is null, soft-deleted, removed from the Workspace, or lacks `processing.consume`, the run sets the rule to `paused` with a `lastError` that says who lost access and that an Owner or Admin can take the rule over. It does not count toward `consecutiveFailures` and does not retry until someone acts. Today soft-deleted creators are skipped silently (`autopilot.service.ts` near the due-rule query) and removed members fail every poll until eight failures; both paths become this pause.
- Add `takeOver(scope, ruleId)`: a Workspace Owner or Admin sets the acting member to themselves, clears the pause reason, and resumes the rule. Use the existing capability that only Owners and Admins hold; don't invent a role check. Record `updatedByUserId`.
- Surface both in the web Autopilot page (`apps/web/app/(app)/autopilot`): a Brand Profile picker on create and edit (same component pattern as link intake), the pause reason, and a "Take over" action for Owners and Admins.

### Integrations

- MCP `narriflow_create_rss_autopilot_rule` and the list tool use `brandProfileId` instead of `brandTemplateId`. Omitted means the Workspace default, resolved at acceptance. Update `packages/validators/src/autopilot.ts` input and snapshot schemas, MCP projections, and docs pages that mention the field (`apps/web/content/docs`).

## Acceptance criteria

- [x] No reference to `AutopilotRule.brandTemplateId` or `rssImportSchema.brandTemplateId` remains.
- [x] A migration under `packages/db/prisma/migrations` drops the column, adds `brandProfileId` with its FK and index, and backfills from `Workspace.defaultBrandProfileId`.
- [x] Manual and Autopilot RSS Projects carry the Brand Profile snapshot; the approval gate reads `approval_required` for an RSS Project whose profile requires it (DB test).
- [x] A rule whose profile can't be applied pauses with an actionable reason and imports nothing (DB test).
- [x] A rule whose acting member was removed pauses on its next run without burning failures; `takeOver` by an Admin resumes it; a Member gets a forbidden error (DB test).
- [x] Web Autopilot page shows the picker, pause reason, and Take over.
- [x] `bun run lint`, `bun run typecheck`, `bun run test`, and the DB gates that include `autopilot.db.test.ts` and `brand-profile.db.test.ts` pass against the local Postgres.

## Verification notes

Run DB gates only against the local Postgres: `DIRECT_URL` and `DATABASE_URL` set to `postgresql://postgres@localhost:55432/postgres?host=/tmp/nfpg`. Never run migrations or gates against the shared Neon database.

## Comments

### Implementation evidence (2026-10-24)

Design choices:

- `takeOver(scope, ruleId)` requires `workspace.manage`, which only Owners and Admins hold. It sets `createdByUserId` and `updatedByUserId` to the caller, activates the rule, and clears the error, pause kind, and failure count. It always revokes any live worker claim, as `updateRule` does, so a run that already judged the previous member unavailable fails its pause as a lost claim instead of pausing the rule on the new member. A non-UUID rule ID is a not-found. Browser route: `POST /api/autopilot/rules/:ruleId/take-over`. No MCP or REST v1 command, so assistants can't escalate ownership.
- The pause reason is `lastError` while `status` is `paused`; a user pause clears it. `pauseKind` (`acting_member` or `brand_profile`, null for a pause someone chose) says which kind of system pause it is. The web page shows the reason in a warning block and offers Take over only for `acting_member`. The MCP list tool projects `pausedReason` (paused rules only) beside `brandProfileId`.
- Choosing a Brand Profile with `updateRule` resumes a rule that Autopilot paused (either kind); a later run pauses it again if the acting member is still unavailable. A rename, or a pause someone chose, changes nothing about the pause.
- A pause leaves `consecutiveFailures`, the feed cursor, and the feed validators alone, so every refused episode imports after the fix.
- Rule create and update refuse a profile that can't be applied (plan, rollout switch, ownership), for a chosen profile and for the defaulted one. This mirrors link intake, which refuses an inapplicable default instead of storing null. `null` stays allowed.
- `autopilotRuleUpdateSchema` is derived from a defaults-free field set, so a partial update (rename, pause toggle, profile change) no longer resets the schedule. The pause toggle still parks `nextRunAt` 24 hours out, as before.
- Brand resolution is one helper in `project.service.ts` (`resolveIntakeBrand`, `intakeBrandColumns`, `recordIntakeBrandApplied`) used by link intake and `importResolvedRssEpisodes`. Omitted `brandProfileId` on `importFromRss` means none, as on browser link intake; the rule and integration intake default to the Workspace profile. MCP accepts `null` for none on rule creation.
- The RSS tab shows only the Brand Profile select (`profileOnly`); the profile's default style applies, because `rssImportSchema` no longer carries a template.
- `autopilot_actor_unavailable` is removed from the failure catalog; nothing throws it now.
- The migration backfills from `Workspace.defaultBrandProfileId`, or from the owner's `User.defaultBrandProfileId` for a personal Workspace below Business, and adds the `AutopilotPauseKind` enum and column. `prisma migrate diff` against the schema is empty.

Verification, all against `postgresql://postgres@localhost:55432/postgres?host=/tmp/nfpg`:

- `bun run typecheck`: 13 of 13 tasks pass.
- `bun run test`: all packages pass (services 917 pass and 328 DB skips, mcp-core 141, web 789, validators 466, worker 650).
- `bun run test:brand-profiles:db`: 13 pass. `bun run test:vizard-expansion:db` (runs `autopilot.db.test.ts`): 50 pass. `test:integration-api:db`, `test:processing-usage:db`, and `test:authenticated-request-policy:db` also pass.
- `bunx biome check apps packages` exits 0 (existing warnings only). Root `bun run lint` also scans the untracked `.scratch/external-integrations/explainer.html`, which has unrelated a11y errors and is not part of this change.
- Not done: no browser-rendered check of the Autopilot page; `autopilot-panel.test.tsx` covers it by server render.
