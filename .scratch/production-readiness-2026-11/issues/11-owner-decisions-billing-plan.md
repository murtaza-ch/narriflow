# 11 Owner decisions: account deletion, plan gates, content cap

**What to build:** Decisions 1, 3, 4 and 5 from `../decisions.md`.

**Blocked by:** None

**Status:** done

## 1. Paid owner deletes their account
Today `markUserDeletedByClerkId` (`packages/auth/src/identity.ts`, wired at `apps/api/src/domains/platform/clerk/runtime.ts`) revokes access but never touches billing. `removeDeletedUserMemberships` keeps owners, so a paid Workspace stays billed with nobody able to reach the portal.

Build:
- Deletion must never be refused, because Clerk can delete a user outside our UI. Handle it from the Clerk deletion path.
- For each Workspace the deleted user owns: if another admin exists, make that member the owner and leave the subscription alone. Otherwise set Stripe `cancel_at_period_end` through a durable obligation with retries, not a best-effort call inside the webhook. Reuse the existing billing reconciliation and operator paths where they fit.
- Choose the oldest admin deterministically. Audit the ownership change the same way other Workspace role changes are audited.
- `docs/runbooks/workspace-billing.md` says automated repair never cancels. That remains true for repair: add this as the one owner-deletion exception.
- Tests on the in-memory store for: sole owner cancels, admin present transfers, retry after a Stripe failure, repeat delivery does nothing twice.

## 3. Audio uploads on Free
`packages/services/src/audio-asset.service.ts:225,247` has no plan gate. Apply `assertBrandMutationAllowedWithAnalytics` on presign and finalize, matching visual assets. Add a per-plan audio file count through `planLimits`/`requireWithinPlanLimit` in `packages/validators/src/pricing.ts`, checked inside a locked transaction like other count limits. Pick limits in proportion to existing asset limits and do not change any price. Existing audio keeps working in clips. Update the plan comparison if it does not already state this.

## 4. Scenes after downgrade
`packages/services/src/clip-export.service.ts:118-127` re-checks Motion and Auto Censor. Add `requirePlanFeature(pricingTier, "brand.scenes")` when `sceneBlocks` is non-empty. Keep the document intact (`assertEditorDocumentFeatureDelta` stays as it is). Finished exports stay downloadable. Check that the web shows a useful message, for example "Remove Scenes or upgrade", through the existing failure and upgrade prompt paths.

## 5. Content suite cap
`packages/services/src/content-suite.service.ts` has a plan gate and a rate limit but no monthly ceiling. Add a monthly generation count per plan in `pricing.ts`, enforced in the service, using a calendar month in UTC or the existing billing period helper. Count from an existing durable record if one exists. If none exists, the migration `20261105000000_production_readiness` is unapplied and may be amended with one small table or column. Refuse with a typed failure that the web shows as an upgrade prompt. No credits are charged. Do not change clip selection.

## Comments

### 2026-11-04 implementation

**1. Deleted owner.** `markUserDeletedByClerkId` now calls `settleDeletedOwnerWorkspaces` (`packages/auth/src/identity.ts`) in the same locked transaction, before non-owner memberships are removed. Deletion is never refused. Each owned Workspace passes to its oldest non-deleted admin (`joinedAt`, then id), whose membership becomes `owner`, with `Workspace.ownerUserId` updated and one billable seat released. With no admin, the Billing Account records `cancelAtPeriodEndRequestedAt` (new column, amended into the unapplied migration). Reconciliation (`workspace-billing.service.ts`) then calls the new provider method `cancelSubscriptionAtPeriodEnd` before committing verified state, with the same retry cadence as a failed seat change (5 minutes). It releases a Narriflow-owned plan-change schedule first, because Stripe rejects cancelling a scheduled subscription. Stripe adapter is in `billing.service.ts` and refuses a subscription whose metadata names another Workspace. Deviations: a personal Workspace never transfers, since its brand data belongs to its owner, so it takes the cancel path. There is no role-change audit table in the repo, so the ownership change is logged as `workspace_owner_deleted` after commit. The runbook records the exception to "repair never cancels".
**3. Audio.** Presign and finalize take the full `BrandActorScope` and call `assertBrandMutationAllowedWithAnalytics(scope, "brand.profiles", "profile")`, the same gate as visual assets. New limit `audioAssets` through `planLimits`/`planCountRequirement`: Free 0, Creator 10, Pro 30, Business 100 live files (brand templates are 3/10/30; files are at most 50 MB). Presign checks the count unlocked for early refusal; finalize checks under `lockBrandOwner(..., "audio-assets")`, replaying an existing key first so a lost race still succeeds. Soft-deleted files free their slot. Existing audio keeps rendering because render resolution is untouched. The legacy user-prefix upload path (unreachable from the API) and its helpers were removed with the old optional context. The comparison already said Free has no uploaded assets; I added an "Uploaded audio files" row with the counts.
**4. Scenes.** `assertClipExportDocumentAllowed` requires `brand.scenes` when `sceneBlocks` is non-empty. The document is untouched. The Studio export failure already goes through `upgradePromptFromFailure`, so the message is "Scenes need the Creator plan." with the upgrade prompt.
**5. Content suite.** No durable record existed (`ContentAsset` upserts, so regeneration does not add up), so the migration gains a small `ContentGeneration` table. `reserveContentGeneration` counts rows in the UTC calendar month under a per-Workspace advisory lock and inserts one row before calling OpenAI. Limits `contentGenerationsPerMonth`: Free 0 (still blocked by the feature), Creator 30, Pro 90, Business 180, proportional to credits. A provider failure deletes the row; an incomplete answer still counts. Refusal is `plan_limit_reached` with `limit: "contentGenerations"`, which the web turns into an upgrade prompt. No credits are charged; clip selection is untouched. The comparison row now shows the monthly count.

**Verification.** Targeted unit tests only. No database gate ran. In-memory coverage: billing cancel, retry after a Stripe failure, repeat reconciliation, schedule release (`workspace-billing.service.test.ts`); transfer vs cancel decisions against a recording fake transaction (`packages/auth/src/owner-deletion.test.ts`); audio and content gates against fake Prisma clients. Not covered by anything that ran: the raw SQL and Prisma writes in `identity.ts`, the Prisma store's `cancelAtPeriodEndRequestedAt` mapping, the advisory locks, the migration SQL, and `audio-asset.db.test.ts` (updated, unrun). Needs a real Stripe sandbox run: `cancel_at_period_end` on a live subscription, including one with a plan-change schedule.
