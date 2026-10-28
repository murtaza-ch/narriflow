# Workspace Billing operations

Workspace Billing is the only owner of Stripe synchronization and Workspace entitlement projection. Webhooks are durable wake-up notifications; only verified current Stripe state can change `Workspace.pricingTier`, `Workspace.status`, retention, or synchronized seats.

## Deployment gate and configuration

Deploy database migrations before web or worker code. For this cutover the required order is the complete Prisma migration chain through:

1. `20260828100000_workspace_entitlement_cutover`
2. `20260828110000_workspace_billing_account`
3. `20260828120000_stripe_delivery_acceptance`
4. `20260828130000_replayable_workspace_checkout`
5. `20260828140000_committed_membership_seats`
6. `20260828150000_reusable_customer_operation_key`
7. `20260828160000_typed_checkout_outcome`
8. `20261026000001_checkout_slot`
9. `20261027140000_workspace_plan_changes`

Run `bun --cwd packages/db run prisma:generate`, then `bun --cwd packages/db run prisma:migrate:deploy` with `packages/db/.env`. Start web and worker only after deployment succeeds.

Stripe SDK requests and webhook fixtures are pinned to API version `2026-07-29.dahlia`, the version represented by the installed Stripe SDK. The Stripe webhook endpoint must use the same version. Upgrade the SDK, pinned API version, fixtures, and endpoint together.

Place secrets only in the owning app-local environment file; never create a root `.env` and never commit credentials:

- `apps/web/.env.local`: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PORTAL_CONFIGURATION_ID`, all eight price IDs, and `DATABASE_URL`.
- `apps/worker/.env`: `STRIPE_SECRET_KEY`, all eight price IDs, `DATABASE_URL`, and optional bounded worker controls.
- `packages/db/.env`: `DATABASE_URL` and `DIRECT_URL` for migrations and disposable database drills.

The price IDs are `STRIPE_PRICE_<TIER>_<INTERVAL>` for every paid tier in `PLAN_CATALOG` (`packages/validators/src/pricing.ts`) and `STRIPE_PRICE_BUSINESS_SEAT_MONTHLY` / `_ANNUAL`. The six base prices must map exactly once to Creator, Pro, and Business monthly/annual. The two additional-seat prices must map exactly once to Business monthly/annual and must not collide with a base price. Web and worker validate this mapping at process startup. The web process additionally requires a `whsec_` webhook secret and `bpc_` portal configuration.

Stripe amounts are not read at runtime; the configured price ID is the authority for plan mapping. Each Stripe price must still match the catalog exactly: `monthlyPriceCents` / `annualPriceCents` of its tier, and `BUSINESS_ADDITIONAL_SEAT_PRICE_CENTS` for seats, in USD, licensed (not metered), with the matching recurring interval. Change the catalog and the Stripe prices together.

Billing worker controls, defaults, and hard ranges:

| Variable | Default | Allowed |
| --- | ---: | ---: |
| `WORKSPACE_BILLING_POLL_INTERVAL_MS` | 5,000 | 250–300,000 |
| `WORKSPACE_BILLING_BATCH_SIZE` | 25 | 1–500 |
| `WORKSPACE_BILLING_CONCURRENCY` | 4 | 1–32 |
| `WORKSPACE_BILLING_LEASE_MS` | 60,000 | 1,000–300,000 |
| `WORKSPACE_BILLING_PROVIDER_DEADLINE_MS` | 10,000 | 100–120,000 |
| `WORKSPACE_BILLING_PROVIDER_CALL_BUDGET` | 4 | 1–20 |

Values must be finite integers. Invalid values stop startup.

## Stripe webhook endpoint

Register `/api/webhooks/stripe` for exactly these event types:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.paused`
- `customer.subscription.resumed`
- `customer.subscription.deleted`
- `customer.subscription.pending_update_applied`
- `customer.subscription.pending_update_expired`
- `subscription_schedule.updated`
- `subscription_schedule.released`
- `subscription_schedule.canceled`
- `subscription_schedule.completed`
- `invoice.paid`
- `invoice.payment_succeeded`
- `invoice.payment_failed`
- `customer.updated`
- `customer.deleted`

Keep sandbox and live completely separate: distinct keys, endpoint, signing secret, prices, products, portal configuration, customers, and event deliveries. Never point a sandbox process at live credentials or reuse live IDs in local files. The endpoint verifies the exact raw body before durable acceptance and stores only the normalized envelope, never the body or signature.

## Stripe catalog and portal

Use one **Narriflow plans** product containing the six fixed USD base prices and one separate **Narriflow Business additional seat** product containing the two seat prices. Stripe charges the subscription; Narriflow reserves and settles monthly processing credits. Annual payment does not grant an annual credit pool. Product and price metadata are diagnostic; configured price IDs own the mapping.

Processing Capacity is also a catalog limit: Free/Creator/Pro/Business allow 2/5/10/20 videos in flight. Admission, usage summaries, and the public comparison read the same catalog value in web and worker. There are no environment overrides for this limit. Worker concurrency settings control execution separately.

Source credits and length caps use the probed duration: 60.01 seconds costs 2 credits, and a source a fraction over its plan's length cap is refused. Ingest ceilings the integer source-duration column while retaining the exact probe for media timing.

Credits reset on the UTC calendar month, not the Stripe renewal date. There is no per-renewal credit grant: a purchase on October 31 can use October's allowance and then November's before Stripe renews. Seats do not multiply credits. An operator refund is a source-credit correction, never a Stripe money refund.

AI image and dub allowances are counted separately from credits. A known failure or cancellation before usable delivery releases the reservation; an unknown provider outcome keeps it reserved pending reconciliation. Free's lifetime image sample counts only requests admitted under the sample policy, so paid image history is never mistaken for trial use, and downgrading cannot grant a second sample. Fonts and Scene Templates keep their feature gates without count limits.

The dedicated portal configuration must be active, disable `subscription_update`, allow payment-method updates and invoice history, cancel at period end, and return to the app's `/settings/billing`. Never expose seat quantity editing. Do not configure all six base prices in one portal catalog: Stripe rejects duplicate product/billing-interval choices. Plan changes belong to Workspace Billing, including subscriptions with separate seat items.

### Plan-change policy

The owner previews a change before confirming a ten-minute quote. The immutable quote records the selected plan/interval, verified subscription items and paid period, current membership seat count, fixed proration timestamp, and actual USD amount due. A durable attempt identifies each Stripe mutation. Reusing a client key with changed input is refused; stale quotes require fresh review. Plan changes and seat reconciliation share the Billing Account claim, without holding a database transaction across Stripe calls.

- Higher tiers and same-tier monthly-to-annual changes are immediate upgrades. `payment_behavior=pending_if_incomplete` and `proration_behavior=always_invoice` keep existing subscription items until payment succeeds. A decline or unfinished 3DS returns the verified hosted invoice for recovery. Pending payment never grants the target tier or resets this month's credit usage. While an upgrade awaits payment, the owner sees **Complete payment** (the verified hosted invoice) and **Keep current plan**, which voids that invoice so Stripe discards the pending update. An unpaid pending update also expires on its own within 23 hours; Stripe then voids its invoice.
- Lower tiers and same-tier annual-to-monthly changes are scheduled at the verified current period end. The two-phase Subscription Schedule keeps the existing paid phase, applies the target phase without proration, then releases into ordinary renewal.
- The owner can keep the current plan by releasing a Narriflow-owned schedule. Releasing does not cancel the subscription. Foreign schedules require support. Remove a scheduled change before using portal cancellation, because Stripe's portal does not cancel scheduled subscriptions.
- Once the final target phase begins, reconciliation releases its owned schedule; portal admission also performs this safe finalization. The underlying subscription keeps running and can be canceled normally.
- Business future phases use the target interval's seat price. Reconciliation updates both current and future phases from committed membership so removed seats cannot return at renewal. Future phases below Business omit seats. Existing below-Business membership restrictions apply only after the lower tier actually takes effect.
- Recover past-due/unpaid invoices and pending cancellation before another plan change. "Outstanding" follows Stripe: a finalized, unpaid (`open` or `uncollectible`) invoice. A renewal invoice in its normal hour-long `draft` window does not block a change. The catalog creates no trials; manually created trial subscriptions must finish or be repaired before this flow. An in-progress upgrade invoice must be paid or resolved before a replacement is submitted.

Checkout creates only a first subscription. Entitlements come only from fresh current-state reconciliation, never the confirmed quote, redirect, invoice URL, or webhook payload.

Reconciliation resumes an interrupted confirming attempt with its original quote and Stripe operation keys, including a schedule attached before ownership metadata was bound. It does not adopt foreign schedules. Recovery is best effort: when the attempt can no longer be completed safely (expired quote, changed source or amount, cancelling or past-due subscription, new owner, foreign schedule) it is marked expired and reconciliation applies the provider's current state, so entitlements never wait on it. Stripe outages, rate limits and network failures are retried rather than treated as conflicts. A new browser request cannot bypass a confirming attempt.

### Stripe test-mode verification

Check the configured catalog and recovery-only portal without creating objects:

```sh
RUN_STRIPE_SANDBOX_CONTRACTS=1 bun --env-file=apps/web/.env.local test \
  packages/services/src/workspace-billing.sandbox.test.ts -t "match the plan catalog"
```

Then verify isolated Stripe test customers and, where the paid-period boundary matters, Test Clocks:

1. Creator-to-Pro upgrade with a succeeding card: the reviewed prorated amount is paid and only a verified new subscription price grants Pro.
2. A declining card and unfinished 3DS: old price/access remain, one pending invoice is recoverable, and retry does not create another charge.
3. Pro-to-Creator and same-tier annual-to-monthly: old paid phase remains until renewal, then the correct target item applies.
4. Monthly-to-annual and mixed tier/interval changes: amount and timing follow the policy above.
5. Replace or undo a schedule; then cancel/reactivate in the portal. Never cancel an operator-owned schedule.
6. Business seats: schedule an interval change, change membership, and verify both phases' quantities. A downgrade removes future seats and the existing access restriction applies at transition if non-owner members remain.
7. Repeat requests, lose a provider response, use concurrent tabs, change seats after a quote, and submit an expired quote. Confirm immutable input, one provider mutation, and recovery without optimistic access.
8. Before a live launch, verify tax and promotion codes: Checkout allows promotion codes, and plan changes keep existing discounts and tax rates.

## Access and recovery policy

- `active` and `trialing` grant the mapped paid plan.
- A first `incomplete` subscription remains `pending_payment` on Free.
- `past_due` retains the last verified paid plan for seven days from its first durable observation. Repeated events and retries never move the deadline.
- `unpaid`, `paused`, `incomplete_expired`, and `canceled` remove paid access.
- Period-end cancellation keeps paid access through the verified provider end date.
- A Workspace without non-owner members is never restricted by plan: a personal Workspace returns to active Free after paid access ends.
- Any Workspace whose plan lacks `workspace.members` (everything below Business) and still has non-owner members, Viewers included, is restricted. This covers a Business-to-Pro or Business-to-Creator change as well as paid access ending. The owner retains billing, viewing, downloads, demotions, and removals. Processing, publishing, API/MCP, editing, and every new member (Viewers included) stop until the owner upgrades or removes the members. One rule, `projectWorkspaceAccessStatus`, decides this in the same transaction that commits the projection, and every membership change wakes reconciliation so a removal lifts the restriction promptly.
- New members and invitations require `workspace.members`; below Business they are refused with `plan_feature_required` (HTTP 402).
- After a downgrade, versioned exports keep their accepted output settings, image and dub requests with durable reservations finish under their accepted grant, and accepted branding or censoring is never silently stripped.

### Checkout admission

- Each Billing Account has at most one open subscription Checkout, held by one Checkout Attempt (`activeBillingAccountId`, unique). The slot is taken in the database before any Stripe call; no transaction is held across a Stripe call.
- Subscription Checkout sessions are created with `expires_at` 31 minutes ahead (Stripe's 30-minute minimum plus a minute so a late-arriving request is not rejected), so an abandoned Checkout holds the slot for about half an hour, not Stripe's 24-hour default. Narriflow never expires a session itself, including on a cancel return.
- A new client key for the same plan and interval resumes the open session. A different choice while a session is open or being prepared is refused with `checkout_in_progress` (HTTP 409, details: plan, interval, session expiry).
- Before a session is created or resumed, Workspace Billing retrieves the customer's subscriptions. Any subscription that is not `canceled` or `incomplete_expired` routes to the portal with `billing_portal_required`, regardless of the projected Free tier.
- A completed Checkout awaiting reconciliation is never replaced. The slot is freed only by a verified expired session, a failed Checkout payment, a completed Checkout whose subscription has verifiably ended, or a preparation that never bound a session within two minutes. A session URL is only returned to the slot holder, so an abandoned preparation cannot leave a payable session behind.
- A replayed client key whose attempt lost the slot returns `checkout_attempt_terminal`; the browser discards the key and starts again.

### Seats and lock order

- Seats converge only on `active`, `trialing`, or `past_due` subscriptions. Canceled, unpaid, paused, and expired subscriptions are never mutated.
- A rejected seat change never blocks the verified projection: the plan, access status, and past-due grace origin commit, and seat convergence retries on the five-minute cadence.
- Seat idempotency keys include the Workspace, subscription, interval, and membership revision, so a returning subscription or interval change cannot replay an older provider operation.
- Projection commits take the Workspace usage lock (`lockWorkspaceUsage`) first, then Project retention rows, then billing rows, matching Processing Usage reservations.

Provider timeouts retain the last verified projection and retry with bounded backoff. Missing metadata, customer conflicts, multiple paid subscriptions, duplicate or unknown seat items, unknown prices, and incomplete pagination move the account to attention. Automated repair never cancels, merges, refunds, deletes, or changes provider billing.

## Diagnosis and safe reconciliation

Start with read-only inspection. The command reports normalized local and provider state without customer, subscription, item, Checkout, event, or attempt IDs:

```sh
bun --env-file=apps/web/.env.local run packages/services/scripts/workspace-billing-operator.ts \
  --workspace 11111111-1111-4111-8111-111111111111
```

Compare local plan, access, health, desired/synchronized seats, ownership classification, subscription count/status, mapped base plan, cancellation, period facts, and provider seat quantity. Then inspect structured `workspace_billing_*` diagnostics by Workspace and phase. Never paste raw Stripe errors, webhook bodies, signatures, URLs, email, address, payment details, or full provider IDs into logs, tickets, analytics, or product copy.

The service emits `workspace_billing_metric` records for delivery disposition and acceptance latency, provider-call success/failure, claim source, queue age, bounded retry bands and delay, settlement outcome, operation duration, desired/synchronized seat quantity, conflicts, grace entry/recovery, restrictions, retention changes, and terminal health. Labels are bounded billing facts such as event class, operation, outcome, retry band, health, access, and transition; they never contain Workspace or provider identifiers. A worker poll that claims no account records nothing; check the worker's `/health` loop status for liveness.

For a safe manual current-state retry, add the explicit switch:

```sh
bun --env-file=apps/web/.env.local run packages/services/scripts/workspace-billing-operator.ts \
  --workspace 11111111-1111-4111-8111-111111111111 \
  --reconcile
```

The command is idempotent. It retrieves current state and invokes the same fenced Workspace Billing interface as the worker. It does not directly edit a tier, cancel, merge, refund, delete, or repair Stripe objects.

Diagnosis guide:

- Accepted or duplicate event but stale UI: confirm worker is running, inspect `nextReconcileAt`, claim age, lease, and retry diagnostics, then reconcile once.
- `retrying`: check Stripe availability and provider deadlines. Preserve current access and let bounded backoff continue.
- `payment_action_required`: confirm the fixed grace deadline and direct the owner to the portal. Do not reset the deadline.
- `attention_required`: inspect ownership, subscription count, price mapping, and seat-item count. Correct sandbox metadata/catalog configuration only after identifying the exact Workspace.
- Customer or subscription conflict: stop automation and escalate. Never merge or delete automatically.
- Seat mismatch: compare committed Admin/Editor count to provider seat quantity, ensure interval-specific seat price, then reconcile. Viewer changes are free. Look for `workspace_billing_seat_convergence_failed` diagnostics; access is already settled while seats retry.
- `checkout_in_progress`: an open or preparing Checkout holds the slot. The owner can resume the same plan and interval, or wait for the session to expire (at most about 31 minutes after it was created). Never expire or delete sessions manually as a fix without identifying the Workspace.
- Retention dispute: compare the verified provider effective time to the Project deadline. A pre-deadline verified upgrade may clear unexpired retention; a post-deadline recovery never restores an expired Project.

## Reproducible verification

Run from the repository root:

```sh
bun run typecheck
bun run lint
bun run test
bun run build
bun test packages/services/src/workspace-billing.service.test.ts --rerun-each 2
bun test packages/services/src/workspace-billing.stripe-contract.test.ts
bun run packages/services/scripts/run-workspace-billing-db-tests.ts
RUN_STRIPE_SANDBOX_CONTRACTS=1 bun --env-file=apps/web/.env.local test \
  packages/services/src/workspace-billing.sandbox.test.ts
```

The database runner creates isolated schemas, applies the full migration chain, seeds representative cutover fixtures, runs concurrency/recovery behavior, and drops both schemas unless `WORKSPACE_BILLING_TEST_KEEP_SCHEMA=1`. Sandbox tests refuse non-`sk_test_` credentials, use isolated metadata, and clean up only their own customer, Checkout, subscription, payment method, and seat objects.

Browser verification uses a real authenticated Chrome session at `/settings/billing` and `/settings/members`. Cover first Checkout and refresh/replay, cancellation, return recovery, leaving during activation, bounded polling, paid portal, payment recovery, a second tab choosing another plan (`checkout_in_progress`), non-owner read-only state, Viewer invite on Business, the below-Business invite refusal, Business-to-Pro restriction with owner removal, billable-member synchronization delay, attention blocking, demotion, and removal. Do not infer activation from a redirect or toast; wait for the verified billing view.

## Rollback and pre-production reset

This is a direct pre-production cutover. Do not add a flag, shadow handler, dual write, legacy parser, old subscription page, direct confirmation endpoint, old fixed-page seat sweep, or fallback renderer.

For application rollback, preserve `WebhookDeliveryLog`, `WorkspaceBillingAccount`, `WorkspaceCheckoutAttempt`, and `WorkspaceBillingTransition` evidence. Roll back code only to a version that understands the deployed schema; otherwise roll forward. Do not reverse migrations against shared data and do not mutate live Stripe objects as part of code rollback.

Because there are no production users or data, inconsistent local fixtures may instead be reset deliberately: stop web and worker, export any evidence needed for debugging, delete only the identified local test Workspaces or recreate the local database, delete only sandbox customers carrying the known test fixture metadata, apply the full migration chain, and restart. Never use a broad customer deletion query and never apply this reset procedure to live mode.

Live-mode mutations remain prohibited until the sandbox matrix, exact event registration, portal catalog, secrets, migration deploy, operator command, database drill, repository checks, and browser checks all pass and are recorded.
