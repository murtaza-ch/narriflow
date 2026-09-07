# Plan 009: Minimize PII in webhook delivery logs

> **Executor**: follow step by step, verify each step. STOP if excerpts don't match.
> **Drift check**: `git status --short apps/web packages/services` — uncommitted tree; excerpts from disk.

## Status
- **Priority**: P2 · **Effort**: S · **Risk**: LOW · **Depends on**: none
- **Category**: security/privacy · **Planned at**: `05d273d`, 2026-07-06

## Why this matters
The Clerk webhook handler persists the **entire** event payload to the webhook
delivery log (`recordWebhookDeliveryLog({ ..., payload: event })`). Clerk
`user.*` events carry PII — email, name, phone, avatar URL. Storing full PII in
an operational log is a data-minimization/GDPR concern and needless breach
surface. We only need enough to debug delivery: event type, id, subject id, and
status. Trim the payload before persisting.

## Current state (verified)
- `apps/web/app/api/webhooks/clerk/route.ts:106-125` — success and failure paths
  both call `recordWebhookDeliveryLog` with `payload: event` (success) and
  `payload: { event, error }` (failure), i.e. the full Clerk event object.
- `recordWebhookDeliveryLog` is exported from `@narriflow/services` (imported at
  `apps/web/app/api/webhooks/clerk/route.ts:6`). Find its definition
  (`grep -rn "recordWebhookDeliveryLog" packages/services/src`) to confirm the
  `payload` field type (likely `Prisma.InputJsonValue`/`unknown`).
- Check whether the Stripe webhook path also logs a full payload
  (`grep -rn "recordWebhookDeliveryLog\|payload" apps/web/app/api/webhooks/stripe packages/services/src/billing.service.ts`); if it does, apply the same trimming there.

## Commands
| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Tests | `bun run test` | all pass |

## Scope
**In scope**:
- `apps/web/app/api/webhooks/clerk/route.ts` — pass a trimmed payload.
- `packages/services/src/*` — only if the safest place to sanitize is a small
  helper next to `recordWebhookDeliveryLog` (a `sanitizeWebhookPayload`); prefer
  trimming at the call site to keep the change contained.
- Stripe webhook logging **only if** it also persists PII.

**Out of scope**: changing the webhook DB schema, altering delivery/relay logic,
adding a log-retention job (note it as follow-up), touching non-webhook logging.

## Steps

### Step 1: Trim the Clerk payload at the call site
Replace `payload: event` with a minimal object and `payload: { event, error }`
with a minimal object that excludes `event.data` PII. Keep only:
```ts
const logPayload = {
  type: event.type,
  eventId: svixId,
  subjectId: (event.data as { id?: string })?.id ?? null,
};
```
Success: `payload: logPayload`. Failure: `payload: { ...logPayload, error: <message> }`.
Do not log `event.data` (email/name/phone/avatar). The `eventType`/`eventId`
fields already passed separately can stay.

**Verify**: `grep -n "payload: event\|payload: {\s*event" apps/web/app/api/webhooks/clerk/route.ts` → no matches (full event no longer logged). `bun run typecheck` → 0.

### Step 2: Stripe parity (conditional)
If the Stripe webhook or `billingService.handleWebhook` logs a full event/payload
containing customer/billing detail, trim it to `{ type, eventId, customerId }`.
If it logs nothing, skip and note it.

**Verify**: `bun run typecheck` → 0; `bun run test` → all pass.

## Test plan
- No new unit test unless a pure `sanitizeWebhookPayload` helper is introduced —
  then add a case asserting it drops `data.email_addresses`/`data.phone_numbers`
  and keeps `type`/`id`. Otherwise rely on typecheck + suite + the grep.

## Done criteria
- [ ] `bun run typecheck` exits 0; `bun run test` exits 0
- [ ] No full Clerk `event` object passed as `payload` to `recordWebhookDeliveryLog` (grep clean)
- [ ] Stripe path checked (trimmed or confirmed no PII logged)
- [ ] Only in-scope files modified (`git status`)

## STOP conditions
- The delivery log is relied on elsewhere to replay the full event (search for a consumer that reads `payload.data`) → STOP and report; trimming would break replay.

## Maintenance notes
- Follow-up (separate): a retention job to purge webhook delivery logs older than N days.
- Reviewer: confirm no `email`, `phone`, or `name` fields remain in the persisted payload.
