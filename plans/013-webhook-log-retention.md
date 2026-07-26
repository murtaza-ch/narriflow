# Plan 013: Webhook delivery log retention

> **Executor**: follow step by step, verify each step. STOP if excerpts don't match.
> **Drift check**: `git status --short packages/auth apps/worker` — uncommitted tree; excerpts from disk.

## Status
- **Priority**: P3 · **Effort**: S · **Risk**: LOW · **Depends on**: none
- **Category**: security/tech-debt · **Planned at**: `05d273d`, 2026-07-06

## Why this matters
`WebhookDeliveryLog` rows are written on every Clerk/Stripe webhook delivery and
never deleted, so the table grows unbounded forever. Plan 009 already minimized
the PII stored per row; retention closes the loop by purging old rows on a
schedule, bounding both storage and residual-data exposure. The worker already
runs a periodic "reap" tick — the natural home for a periodic purge.

## Current state (verified)
- Model `packages/db/prisma/schema.prisma:526` `WebhookDeliveryLog` has
  `createdAt DateTime @default(now())` and `processedAt DateTime @default(now())`
  — either works as the age field; use `createdAt`.
- Log writes go through `recordWebhookDeliveryLog` in `packages/auth/src/index.ts:256`
  (that's where the model access lives — `prisma.webhookDeliveryLog`). Add a
  `purgeOldWebhookDeliveryLogs` function next to it.
- Worker reap tick: `apps/worker/src/index.ts` `reapStalledRunsIfDue()` (~line 25)
  runs on an interval (`reapIntervalMs`, gated by `lastReapAt`). It already calls
  `reapStuckWorkflowRuns`/`reapStuckIngestJobs`/`reapStuckPublishingPosts` and
  logs counts in structured JSON. Add the purge call here.
- The auth package exports these functions from `packages/auth/src/index.ts`; the
  worker imports from `@narriflow/auth` (check existing imports in
  `apps/worker/src/index.ts` / the services it uses — if the worker doesn't
  already depend on `@narriflow/auth`, prefer adding the purge to
  `@narriflow/services` instead and call it from the worker to avoid a new
  cross-package dependency; decide based on what the worker already imports).

## Commands
| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Tests | `bun run test` | all pass |
| Lint | `bunx @biomejs/biome check .` | exit 0 |

## Scope
**In scope**:
- Add `purgeOldWebhookDeliveryLogs(olderThanDays)` where the `webhookDeliveryLog`
  Prisma access already lives (`packages/auth/src/index.ts`) OR in
  `packages/services` if that avoids a new worker→auth dependency.
- Wire a periodic purge call into `apps/worker/src/index.ts` reap tick.

**Out of scope**: no schema change (createdAt already exists); do not change
`recordWebhookDeliveryLog`; no new dependency; do not delete rows newer than the
retention window.

## Steps

### Step 1: Purge function
Add:
```ts
/** Deletes webhook delivery logs older than the retention window. Returns count. */
export async function purgeOldWebhookDeliveryLogs(olderThanDays = 30): Promise<number> {
  const prisma = getRequiredPrisma(); // or requirePrisma() in services
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const res = await prisma.webhookDeliveryLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return res.count;
}
```
Match the surrounding module's prisma-accessor helper name and export style.

**Verify**: `grep -n "purgeOldWebhookDeliveryLogs" <the file>` → matched; `bun run typecheck` → 0.

### Step 2: Wire into the worker reap tick
In `reapStalledRunsIfDue()`, after the existing reaper calls, add:
```ts
const purgedLogs = await purgeOldWebhookDeliveryLogs(
  Number(process.env.WEBHOOK_LOG_RETENTION_DAYS ?? 30),
);
if (purgedLogs > 0) {
  console.log(JSON.stringify({ level: "info", message: "webhook_logs_purged", count: purgedLogs, ts: new Date().toISOString() }));
}
```
Import the function from wherever you defined it. The reap tick already runs on
`reapIntervalMs`, so no new scheduler is needed — the purge piggybacks on it.
Because purge only affects rows past the window, running it every reap tick is
cheap and idempotent.

**Verify**: `grep -n "purgeOldWebhookDeliveryLogs\|webhook_logs_purged" apps/worker/src/index.ts` → matched; `bun run typecheck` → 0.

### Step 3: Document the env knob
Add `WEBHOOK_LOG_RETENTION_DAYS=30` to `apps/worker/.env.example` under the other
worker runtime settings (match the existing comment style). This is the only
`.env.example` edit; do not touch real `.env` files.

**Verify**: `grep -n "WEBHOOK_LOG_RETENTION_DAYS" apps/worker/.env.example` → matched.

## Test plan
- DB/time-bound; no test DB. Gate on typecheck + suite green + biome check.
- Optionally add a trivial unit test if the cutoff math is extracted into a pure
  helper; otherwise skip (don't mock Prisma to assert nothing).

## Done criteria
- [ ] `bun run typecheck` exits 0; `bun run test` exits 0; `bunx @biomejs/biome check .` exits 0
- [ ] `grep -rn "purgeOldWebhookDeliveryLogs" packages apps` → definition + worker call
- [ ] `grep -n "WEBHOOK_LOG_RETENTION_DAYS" apps/worker/.env.example` → matched
- [ ] Only in-scope files modified (`git status`)

## STOP conditions
- The worker does not already import from `@narriflow/auth` AND adding that
  dependency is non-trivial → put the purge in `@narriflow/services` (already a
  worker dependency) and note it.
- `getRequiredPrisma`/`requirePrisma` accessor name differs from the surrounding code → use the local one; report if none exists.

## Maintenance notes
- If webhook volume grows huge, move the purge to a DB TTL/partition or a dedicated cron instead of the reap tick.
- Reviewer: confirm the cutoff uses `<` (strictly older) and a sane default (30 days).
