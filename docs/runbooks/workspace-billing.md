# Workspace Billing operations

Workspace Billing is the only owner of Stripe synchronization and Workspace entitlement projection. Webhooks are durable wake-up notifications; only verified current Stripe state can change `Workspace.pricingTier`, `Workspace.status`, retention, or synchronized seats.

## Deployment gate and configuration

Deploy database migrations before web or worker code. For this cutover the required order is the complete Prisma migration chain through:

1. `20260828100000_workspace_entitlement_cutover`
2. `20260828110000_workspace_billing_account`
3. `20260828120000_workspace_billing_delivery_claims`
4. `20260828130000_replayable_workspace_checkout`
5. `20260828140000_committed_membership_seats`

Run `bun --cwd packages/db run prisma:generate`, then `prisma migrate deploy` with `packages/db/.env`. Start web and worker only after deployment succeeds.

Stripe SDK requests and webhook fixtures are pinned to API version `2026-07-29.dahlia`, the version represented by the installed Stripe SDK. The Stripe webhook endpoint must use the same version. Upgrade the SDK, pinned API version, fixtures, and endpoint together.

Place secrets only in the owning app-local environment file; never create a root `.env` and never commit credentials:

- `apps/web/.env.local`: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PORTAL_CONFIGURATION_ID`, all eight price IDs, and `DATABASE_URL`.
- `apps/worker/.env`: `STRIPE_SECRET_KEY`, all eight price IDs, `DATABASE_URL`, and optional bounded worker controls.
- `packages/db/.env`: `DATABASE_URL` and `DIRECT_URL` for migrations and disposable database drills.

The six base prices must map exactly once to Creator, Pro, and Business monthly/annual. The two additional-seat prices must map exactly once to Business monthly/annual and must not collide with a base price. Web and worker validate this catalog at process startup. The web process additionally requires a `whsec_` webhook secret and `bpc_` portal configuration.

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

## Portal catalog

The configured portal must be active and must:

- expose only the six Narriflow base-plan prices for Creator, Pro, and Business monthly/annual;
- allow price changes with `create_prorations` and keep quantities fixed at one;
- allow payment-method recovery and invoice history;
- schedule cancellation at period end;
- return to `/settings/billing`;
- exclude the additional-seat product, because committed Workspace membership owns that quantity.

Checkout is only for the first Free-to-paid subscription. A paid Workspace always uses this configured portal for plan, interval, payment method, invoice, and cancellation changes.

## Access and recovery policy

- `active` and `trialing` grant the mapped paid plan.
- A first `incomplete` subscription remains `pending_payment` on Free.
- `past_due` retains the last verified paid plan for seven days from its first durable observation. Repeated events and retries never move the deadline.
- `unpaid`, `paused`, `incomplete_expired`, and `canceled` remove paid access.
- Period-end cancellation keeps paid access through the verified provider end date.
- A personal Workspace returns to active Free after paid access ends.
- A collaborative Workspace with non-owner members becomes restricted on Free. The owner retains billing, viewing, downloads, Viewer invitations, demotions, and removals. Processing, publishing, API/MCP, editing, and new billable additions stop.

Provider timeouts retain the last verified projection and retry with bounded backoff. Missing metadata, customer conflicts, multiple paid subscriptions, duplicate or unknown seat items, unknown prices, and incomplete pagination move the account to attention. Automated repair never cancels, merges, refunds, deletes, or changes provider billing.

## Diagnosis and safe reconciliation

Start with read-only inspection. The command reports normalized local and provider state without customer, subscription, item, Checkout, event, or attempt IDs:

```sh
bun --env-file=apps/web/.env.local run packages/services/scripts/workspace-billing-operator.ts \
  --workspace 11111111-1111-4111-8111-111111111111
```

Compare local plan, access, health, desired/synchronized seats, ownership classification, subscription count/status, mapped base plan, cancellation, period facts, and provider seat quantity. Then inspect structured `workspace_billing_*` diagnostics by Workspace and phase. Never paste raw Stripe errors, webhook bodies, signatures, URLs, email, address, payment details, or full provider IDs into logs, tickets, analytics, or product copy.

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
- Seat mismatch: compare committed Admin/Editor count to provider seat quantity, ensure interval-specific seat price, then reconcile. Viewer changes are free.
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

Browser verification uses a real authenticated Chrome session at `/settings/billing` and `/settings/members`. Cover first Checkout and refresh/replay, cancellation, return recovery, leaving during activation, bounded polling, paid portal, payment recovery, non-owner read-only state, Viewer invite, billable-member synchronization delay, attention blocking, demotion, and removal. Do not infer activation from a redirect or toast; wait for the verified billing view.

## Rollback and pre-production reset

This is a direct pre-production cutover. Do not add a flag, shadow handler, dual write, legacy parser, old subscription page, direct confirmation endpoint, old fixed-page seat sweep, or fallback renderer.

For application rollback, preserve `WebhookDeliveryLog`, `WorkspaceBillingAccount`, `WorkspaceCheckoutAttempt`, and `WorkspaceBillingTransition` evidence. Roll back code only to a version that understands the deployed schema; otherwise roll forward. Do not reverse migrations against shared data and do not mutate live Stripe objects as part of code rollback.

Because there are no production users or data, inconsistent local fixtures may instead be reset deliberately: stop web and worker, export any evidence needed for debugging, delete only the identified local test Workspaces or recreate the local database, delete only sandbox customers carrying the known test fixture metadata, apply the full migration chain, and restart. Never use a broad customer deletion query and never apply this reset procedure to live mode.

Live-mode mutations remain prohibited until the sandbox matrix, exact event registration, portal catalog, secrets, migration deploy, operator command, database drill, repository checks, and browser checks all pass and are recorded.
