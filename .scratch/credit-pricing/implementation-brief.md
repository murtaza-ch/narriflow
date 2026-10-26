# Credit pricing — shared implementation brief (read fully before editing)

Repo: /Users/murtaza/Documents/dev/narriflow. Read `AGENTS.md` (engineering principles, pre-production policy:
no compatibility layers, remove old paths in the same change), then `.scratch/credit-pricing/plan.md`
(gpt-6.1-sol's audit + plan; section 8 at the end records the adopted decisions and scope cuts, which
override earlier sections where they conflict).

## Already done (do not redo)

- `packages/validators/src/pricing.ts` is the plan catalog: `PLAN_CATALOG`, `planFeatureSchema`/`PlanFeature`,
  `hasFeature`, `planLimits`, `planDefinition`, `lowestTier`, `lowestTierWithFeature`,
  `creditsForSourceSeconds`, `creditDebitSeconds`, `processingPeriodStart`/`processingPeriodEnd`,
  `planHighlights`, `formatUsdCents`, `BUSINESS_ADDITIONAL_SEAT_PRICE_CENTS`, `PAID_ACCESS_ENDED_GRACE_DAYS`.
  Removed: `MONTHLY_PROCESSING_MINUTE_LIMITS`, `MAX_UPLOAD_LENGTH_SECONDS`, `PROCESSING_CAPACITY_DEFAULTS`,
  `PRICING_TABLE`, `PRICING_FEATURES`, `BUSINESS_ADDITIONAL_SEAT_PRICE`, `processingMinutesFromSeconds`,
  and the `generated.video` feature. New features: `export.timelines`, `brand.customTemplates`,
  `brand.defaultScenes`, `brand.governance`, `content.repurposing`, `publishing.schedule`,
  `automation.autopilot`, `workspace.members`. API/MCP (`integrations.*`) are now Pro+.
  If the catalog needs a change, report it back rather than editing it; the owner of
  `pricing.ts` is the orchestrator (exception: slice owners explicitly told otherwise).
- `packages/services/src/plan-features.ts`: re-exports `hasFeature`/`planLimits`, plus the ONE shared plan
  refusal: `PlanRequirementError` (codes `plan_feature_required` | `plan_limit_reached`, kind
  `payment_required`, details `{feature?|limit?, used?, max?, currentTier, requiredTier}`),
  `requirePlanFeature(tier, feature)`, `requireWithinPlanLimit(tier, limit, used, adding?)`.
  Exported from `packages/services/src/index.ts`.
- `packages/services/src/processing-usage.ts` converted to credits: debits stored as whole-credit seconds
  (multiples of 60), `credits_exhausted` (was `processing_quota_exhausted`), new
  `credits_reservation_released`, summary fields `usedCredits/reservedCredits/limitCredits/remainingCredits/
  periodStart/renewsAt`, reserve refuses inactive Workspaces, legacy settle auto-admission removed.
  `lockWorkspaceUsage(tx, workspaceId)` is exported for billing to share the Workspace usage lock.

## Rules for every worker

- Several workers edit this checkout concurrently. Only edit files in your slice's ownership list. If you must
  touch a file outside it (e.g. one line in `packages/services/src/index.ts`, `apps/web/app/api/[[...route]]/route.ts`,
  `packages/validators/src/error-messages.ts`, `packages/db/prisma/schema.prisma`), make a minimal, surgical
  Edit and re-read the file immediately before editing. Never reformat whole files you don't own.
- NEVER run `git stash`, `git checkout`, `git reset`, `git clean`, `git commit`, or `biome --write`/`--fix`
  on the repository. Run `bunx biome check <your files>` (no write) to lint your own files.
- Replace module-specific plan refusals in your area (e.g. `brand_entitlement_required`,
  `auto_censor_entitlement_required`, `*_plan_required`) with `requirePlanFeature`/`PlanRequirementError`, and
  update the web/MCP/REST code and tests that match on the old code. Role/permission refusals stay as they are.
  Provider/rollout unavailability stays distinct from plan refusal.
- Count limits are checked inside the transaction that writes the object, after serializing on the owner
  (advisory xact lock or `SELECT ... FOR UPDATE` on the owning row), counting in that transaction.
  Removal/disable/cleanup must always remain possible when over a limit or after a downgrade.
- Migrations: create your own directory under `packages/db/prisma/migrations/` with the timestamp prefix you were
  assigned. Edit only your models in `schema.prisma`. Run `bun run --cwd packages/db prisma:generate` after schema
  edits. Do NOT apply migrations to the shared Neon database.
- DB gates: run them against the throwaway local Postgres, never Neon:
  `export L='postgresql://postgres@localhost:55432/postgres?host=/tmp/nfpg'` then
  `DIRECT_URL=$L DATABASE_URL=$L <GATE>_TEST_DATABASE_URL=$L bun run test:<gate>:db`
  (check the gate's runner in `packages/services/scripts/` or `apps/web/scripts/` for its exact env var name).
  If the local server is down, report it; do not start a new cluster on the same port.
- Fast checks: `bun run --cwd packages/services typecheck`, `bun test <file>` for focused suites,
  `bun run typecheck` at the end. Other workers' in-progress edits may cause unrelated type errors; report them
  rather than fixing files you don't own.
- Structured logs: `console.warn(JSON.stringify({ level, message, ...ctx }))`.
- Return: changed files, a concise summary of behavior changes, checks run with results (exact commands),
  migrations created, and unresolved risks or catalog changes you need.
