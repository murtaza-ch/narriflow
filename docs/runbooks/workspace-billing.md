# Workspace Billing operations

## Required configuration

When `STRIPE_SECRET_KEY` is set, startup validates all Creator, Pro, Business, and Business-seat monthly and annual price IDs. It also validates the worker batch size, concurrency, lease duration, provider deadline, and call budget. A missing, duplicate, colliding, non-finite, or out-of-range value stops the process before billing work begins.

Register only these Stripe event families: Checkout completion and delayed-payment outcomes, subscription create/update/pause/resume/delete, invoice payment success/failure, and relevant customer changes. Configure `STRIPE_WEBHOOK_SECRET` on the Hono raw-body boundary at `/api/webhooks/stripe`. Apply all pending Prisma migrations before deploying code that reads Workspace Billing Accounts.

## Access policy

- `active` and `trialing` grant the mapped paid plan.
- A first `incomplete` subscription remains pending payment on Free.
- `past_due` retains the last verified paid plan for seven days from its first durable observation. Reconciliation never moves that deadline.
- `unpaid`, `paused`, `incomplete_expired`, and `canceled` remove paid access.
- An active subscription with period-end cancellation keeps paid access through its provider end date.
- A personal Workspace becomes active on Free after paid access ends.
- A collaborative Workspace with non-owner members becomes restricted on Free. The owner keeps billing, view, and download access. Editing, processing, publishing, API and MCP access, and billable member additions stop.

Provider timeouts keep the last verified projection and retry with bounded backoff. Missing metadata, customer conflicts, multiple paid subscriptions, duplicate seat items, and unmapped prices require attention. Do not cancel, merge, refund, or delete provider objects automatically.

## Repair

Inspect structured `workspace_billing_*` diagnostics by Workspace and phase. Do not paste provider IDs or raw errors into user-facing messages. Correct the catalog, customer metadata, or subscription conflict in Stripe sandbox, then set the account due or wait for its periodic reconciliation. Never edit `Workspace.pricingTier` directly.
