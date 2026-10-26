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
- `invoice.paid`
- `invoice.payment_succeeded`
- `invoice.payment_failed`
- `customer.updated`
- `customer.deleted`

Keep sandbox and live completely separate: distinct keys, endpoint, signing secret, prices, products, portal configuration, customers, and event deliveries. Never point a sandbox process at live credentials or reuse live IDs in local files. The endpoint verifies the exact raw body before durable acceptance and stores only the normalized envelope, never the body or signature.

## Stripe catalog and portal

Use one product layout so the portal can schedule every downgrade. Stripe schedules a cross-price downgrade at period end only between prices of the same product.

- One **Narriflow plans** product with six recurring prices: Creator, Pro, and Business, each monthly and annual.
- One **Business additional seat** product with a monthly and an annual price. Committed Workspace membership owns its quantity; the portal never edits it.
- Product and price metadata are diagnostic only. Mapping is by configured price ID.

The configured portal (`STRIPE_PORTAL_CONFIGURATION_ID`) must be active and must:

- expose only the six plans-product prices for plan and interval changes, with quantity fixed at one;
- apply upgrades immediately with `proration_behavior: always_invoice`, so the prorated amount is invoiced and charged at the moment of change instead of deferred to the next renewal;
- schedule downgrades at period end with `schedule_at_period_end.conditions` `decreasing_item_amount` and `shortening_interval`;
- schedule cancellation at period end;
- allow payment-method recovery and invoice history;
- return to `/settings/billing`;
- exclude the additional-seat product.

Checkout is only for a first subscription. A Workspace whose subscription can still bill always uses this portal for plan, interval, payment method, invoice, recovery, and cancellation changes. Narriflow has no plan-change endpoint of its own.

Entitlement never comes from webhook or redirect payloads. Workspace Billing grants the mapped tier only after retrieving the current subscription collection. Note for upgrades: a subscription that becomes `past_due` keeps the *last verified* tier during grace, not the newly mapped price, so an upgrade whose immediate invoice fails is not granted if reconciliation first observes `past_due`. If reconciliation observes `active` between the plan change and the payment failure, the higher tier applies until the next reconciliation sees `past_due`.

### Owner verification in Stripe test mode (before launch)

First check the configured catalog and portal without creating Stripe objects:

```sh
RUN_STRIPE_SANDBOX_CONTRACTS=1 bun --env-file=apps/web/.env.local test \
  packages/services/src/workspace-billing.sandbox.test.ts -t "match the plan catalog"
```

It verifies every price amount, currency, and interval against `PLAN_CATALOG` and `BUSINESS_ADDITIONAL_SEAT_PRICE_CENTS`, the single plans product, the separate seat product, and the portal's `always_invoice` upgrades, period-end downgrade conditions, and period-end cancellation.

Then run each case against the sandbox catalog and record the resulting subscription status, latest invoice status, and the Narriflow billing view after reconciliation:

1. Creator monthly to Pro monthly with a succeeding card: one prorated invoice is paid at the time of change; the view shows Pro.
2. The same upgrade with a 3-D Secure card (`4000 0027 6000 3184`) left unauthenticated, and with a declining card (`4000 0000 0000 0341`): confirm whether the portal applies the new price before payment. If the subscription ends up `active` on the higher price with an unpaid invoice, the portal cannot guarantee payment-dependent upgrades. In that case disable portal upgrades and add the narrow Workspace Billing plan-change operation (invoice preview plus a pending update) before launch; keep the portal for recovery, downgrades, and cancellation.
3. Pro to Creator and annual to monthly: the change is scheduled for the period end, current access is unchanged until then, and the view shows the lower plan only after the provider applies it.
4. Cancellation at period end, then reactivation before the end date.
5. A Business subscription that has an additional-seat item: confirm what the portal allows. Multi-item subscriptions may not support self-serve plan changes; if they do not, document that the owner removes billable members (the seat item goes to zero) before changing plan.
6. A past-due subscription after the seven-day grace: the view offers only the portal, and starting Checkout is refused with `billing_portal_required`.

## Access and recovery policy

- `active` and `trialing` grant the mapped paid plan.
- A first `incomplete` subscription remains `pending_payment` on Free.
- `past_due` retains the last verified paid plan for seven days from its first durable observation. Repeated events and retries never move the deadline.
- `unpaid`, `paused`, `incomplete_expired`, and `canceled` remove paid access.
- Period-end cancellation keeps paid access through the verified provider end date.
- A Workspace without non-owner members is never restricted by plan: a personal Workspace returns to active Free after paid access ends.
- Any Workspace whose plan lacks `workspace.members` (everything below Business) and still has non-owner members, Viewers included, is restricted. This covers a Business-to-Pro or Business-to-Creator change as well as paid access ending. The owner retains billing, viewing, downloads, demotions, and removals. Processing, publishing, API/MCP, editing, and every new member (Viewers included) stop until the owner upgrades or removes the members. One rule, `projectWorkspaceAccessStatus`, decides this in the same transaction that commits the projection, and every membership change wakes reconciliation so a removal lifts the restriction promptly.
- New members and invitations require `workspace.members`; below Business they are refused with `plan_feature_required` (HTTP 402).

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

The service emits `workspace_billing_metric` records for delivery disposition and acceptance latency, provider-call success/failure, claim source, queue age, bounded retry bands and delay, settlement outcome, operation duration, desired/synchronized seat quantity, conflicts, grace entry/recovery, restrictions, retention changes, and terminal health. Labels are bounded billing facts such as event class, operation, outcome, retry band, health, access, and transition; they never contain Workspace or provider identifiers.

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
