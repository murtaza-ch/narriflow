# 08 Billing

**What to build:** Stripe state edges resolve correctly and reservations cannot leak.

**Blocked by:** None

**Status:** done

Owns: `packages/services/src/{workspace-billing.service,billing.service,billing-reconciliation,generated-media-usage-ledger,processing-usage,workspace-plan-change}.ts`, `packages/auth/src/identity.ts` deletion path only (ticket 01 owns the rest of that file).

Do not change prices. Decisions 1, 3, 4, 5 in `decisions.md` are the owner's.

## Must fix
1. **Deleting a Project during an AI image job leaks a concurrency slot (medium).** `project.service.ts:710,783`, `schema.prisma:2463`, `generated-media-usage-ledger.ts:106-108,412`. `reconcileGenerationUsageReservations` and `reconcileStranded` have no production caller. Wire the sweep into `execution-maintenance` (coordinate: ticket 03 owns that file, keep the edit small) or settle in the delete transaction. Delete whichever stays unused and update ADR 0012. Retention has the same hole at `project-retention-execution.ts:65`.
2. **Deleted Stripe customer keeps the paid tier (medium).** `billing.service.ts:349-351`, `workspace-billing.service.ts:2278,2758-2765`. `customer_missing` retries forever. Return a typed state, commit Free through the same path as `canceled` including the retention transition, clear `providerCustomerId`.
3. **Unpaid pending Business Workspace released as active Free (medium, plausible).** `workspace-billing.service.ts:2495-2501,2512-2516`. Keep `pending_payment` for a Workspace that was pending with no successful payment, at minimum on `incomplete_expired`.
4. **Refund needs have no reader (medium).** `processing-usage.ts:725`, `source-readiness.ts:74`, `ingest-job-lifecycle.ts:463`. Add an operator command next to `workspace-billing-operator.ts` that lists open `SourceRefundNeed` rows, calls `refund`, and resolves them. Document it in the billing runbook. If "resolved" needs a schema change, record it for ticket 02 in Comments.
5. **Deleted members stay billable seats (low).** `workspace-billing.service.ts:1155-1158,1932-1937`, `packages/auth/src/identity.ts:290`. Remove memberships at deletion or exclude deleted users from both counts and bump `seatRevision`.
6. **Seat count and revision read non-atomically (low, plausible).** `workspace-billing.service.ts:1155,2548,2609`. Include desired quantity in `operationKey`.
7. **Past-due grace can keep a higher tier (low).** `workspace-billing.service.ts:2490`. Use the lower rank of `current.pricingTier` and `mapped.tier`.
8. **Active Free Workspace can flip to `pending_payment` (low).** `workspace-billing.service.ts:2235,2364-2367`. Pass `awaitingFirstPayment: current.status === "pending_payment"`.
9. **Prisma no-subscription commit diverges from in-memory (low).** `workspace-billing.service.ts:1798-1818` vs `:953-968`. Set `snapshot: Prisma.JsonNull` and run the same delivery update.

## Reuse
- Move `createInMemoryWorkspaceBillingStore` (`workspace-billing.service.ts:605`, ~440 lines) to test support.
- One row-to-projection function: `latestCheckout` mapping (`:1129,:1840`), Workspace select (`:1075,:1765,:1891`).
- One render planning function: `clip.service.ts:2135`, `workflow-run-lifecycle.ts:2425-2429` (small edit; ticket 03 owns the file).
- Named subscription status sets: `workspace-billing.service.ts:97,2409,2430`, `workspace-plan-change.ts:77`.

## Verification
`test:workspace-billing:db`, `test:processing-usage:db`.

## Comments

All nine findings confirmed in code; none rejected. Prices untouched; decisions 1, 3, 4, 5 not acted on.

**Fixed**
1. Added hourly phases `usage_reservations` and `generation_reservations` (`execution-maintenance.ts`, `execution-maintenance-runtime.ts`). `reconcileStranded` is now a transaction page and `reconcileGenerationUsageReservations` became `reconcileGenerationUsagePage`, because maintenance handlers run inside the page transaction. Both sweeps stay in use, so neither was deleted. A slot can stay held up to about 70 minutes after a delete (10 minute grace plus the hourly cadence). Deleted subjects stay counted. ADR 0012 updated.
2. `retrieveCurrentState` returns ownership `customer_deleted`. `commitNoSubscriptionState` with `customerDeleted` commits Free, applies the retention transition, writes a `provider_customer_deleted` transition, and clears customer, seat item and synchronized seats. Removed the unused `customer_missing` code.
3. Every ended status keeps `pending_payment` for a Workspace that was pending. The owner can start Checkout again.
4. New `processing-usage-operator.ts` and `scripts/processing-usage-operator.ts` (`usage:operator`). No schema change: `resolvedAt` exists. Documented in the runbook.
5. `markUserDeletedByClerkId` removes non-owner memberships under a row lock, drops the seat, bumps `seatRevision` and sets `nextReconcileAt`. `packages/auth` cannot import services, so the wake is the hourly `billing_wakes` page, not an immediate dispatch.
6. Seat `operationKey` includes the desired quantity.
7. Past-due grace uses the lower of current and mapped tier.
8. `settleNoSubscription` passes `awaitingFirstPayment: current.status === "pending_payment"`. The view still reports `payment_pending` for Free while activating, so the web contract is unchanged.
9. Prisma no-subscription commit sets `snapshot: Prisma.JsonNull` and settles accepted deliveries.

**Found while fixing, also fixed**
- A completed Checkout kept its slot, and `startCheckout` refuses with `checkout_in_progress` forever once the customer is gone. The deleted-customer commit now frees the slot.
- Prisma `commitNoSubscriptionState` had no retention transition or audit row; it only ever ran on Free before.

**Deliberate limits**
- A Stripe 404 is not treated as deletion: the wrong key or mode must never downgrade anyone, so it keeps retrying. Only `deleted: true` counts.
- `customerOperationKey` is stable per Workspace, so a Checkout within Stripe's 24 hour idempotency window of the original create replays the deleted customer's response. The request then fails `customer_identity_conflict` and recovers once the window passes. Fixing it needs a customer generation column, so it is left for a real report.
- `requireNoBillableSubscription` and plan changes treat `customer_deleted` as `customer_identity_conflict` until reconciliation clears the customer, which `customer.deleted` wakes at once.

**Reuse**
- `createInMemoryWorkspaceBillingStore` moved to `workspace-billing.memory-store-test-support.ts`; removed from the barrel.
- `toProjection`, `projectionWorkspaceSelect` and `latestCheckoutQuery` replace the three copies.
- Render planning: `clip.service.ts` `planRenderGroups` had no callers, so it was deleted. `workflow-run-lifecycle.ts` is the one planner and was not edited.
- `ENDED_SUBSCRIPTION_STATUSES` and `ENTITLED_SUBSCRIPTION_STATUSES` are named and shared; the redundant second filter is gone.

**Verification** (local test database)
- `test:workspace-billing:db`: 36 pass, 0 fail (6 new, red first).
- `test:processing-usage:db`: 34 pass, 1 fail. The failure is `project_has_active_workflow` from `deleteProject` in the link and RSS test, from ticket 02's delete change, not this ticket.
- `test:vizard-expansion:db`: 19, 4, 8 and 73 pass across its four steps, including the new sweep tests in `generation-usage.db.test.ts`.
- `test:authenticated-request-policy:db`: 18 pass (1 new, red first).
- Unit tests: billing, plan change, contract and operator suites 103 pass.
- `packages/auth` unit tests: 92 pass. Its fixture gained a `$queryRaw` stub for the membership row lock.
- `build:worker` import audit: passed.
- `test:execution:db` does not pass at this moment, but no failure touches this ticket: they come from `resolveIngestSourceDefinition`, the restriction and render-identity work in tickets 03 and 04. `execution-maintenance-runtime.db.test.ts` and `billing-reconciliation.db.test.ts` pass.
