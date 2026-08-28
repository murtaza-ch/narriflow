# 05 — Make Checkout and customer provisioning replayable

**What to build:** Let a Free or pending-payment Workspace start its first subscription once, recover an ambiguous Stripe customer or Checkout response, and show truthful activation progress until background reconciliation verifies the plan. Existing paid Workspaces change billing through Stripe's hosted portal.

**Blocked by:** [04 — Apply subscription health, access, and retention policy](04-apply-subscription-health-access-and-retention-policy.md).

**Status:** completed

**Specification:** [Deepen Workspace Billing synchronization](../spec.md)

## Observable acceptance criteria

- [x] The browser creates and stores a client Checkout idempotency key before its first start request.
- [x] One durable Checkout attempt binds Workspace, actor, target tier, interval, catalog version, return destination, provider phase, session outcome, and expiry.
- [x] Replaying the same key and immutable inputs returns the same live Checkout destination or terminal result without another customer or session creation.
- [x] Reusing a key with different Workspace, tier, interval, or return facts returns a typed conflict and changes no billing state.
- [x] Only an owner with billing capability may start Checkout, observe its return, or open the portal.
- [x] Checkout is available only when the Workspace has no entitlement-bearing subscription or is pending its first payment.
- [x] Existing paid Workspaces use a configured customer portal catalog for plan, interval, payment-method, invoice, and cancellation changes.
- [x] Customer provisioning writes durable operation intent before the provider call and uses a stable provider idempotency key.
- [x] A lost provider response retries the same operation while safe, then reconciles exact Workspace metadata before any new create.
- [x] Exactly one recovered provider customer binds to the Workspace Billing Account.
- [x] Multiple matching customers or a customer already bound elsewhere produce operator attention and no automatic merge or deletion.
- [x] A lost database bind after customer creation can recover the same customer without creating another.
- [x] Checkout creation uses the bound customer, immutable metadata, configured base price, and workspace-scoped return facts.
- [x] Checkout return observation verifies the session belongs to the current Workspace and durable attempt.
- [x] Return observation never writes a tier from the Checkout Session. It records the outcome, marks reconciliation due, and returns the current billing view.
- [x] A short inline reconciliation may finish activation, but a slow result returns `activating` with `Retry-After` rather than holding the request open.
- [x] Activation polling uses bounded jitter, survives transient request failure, and may continue after navigation or page close through the worker.
- [x] The UI shows success only after the verified billing view is current. The old optimistic upgrade toast and direct confirmation endpoint behavior are removed.
- [x] Incomplete or delayed payment remains pending, failed or expired Checkout leaves the prior plan unchanged, and retry starts or resumes safely.
- [x] A canceled new Business Workspace stays pending with a clear Complete setup action and can switch away without losing other Workspaces.
- [x] Portal return relies on delivery and current-state reconciliation and does not assume the owner changed anything.

## Public-interface and failure-injection tests

- [x] Interface tests cover fresh start, replay, immutable conflict, concurrent start, active paid refusal, pending retry, Checkout expiry, and completed replay.
- [x] Failure injection covers customer create timeout, create success before database bind, metadata lookup delay, Checkout create timeout, Checkout success before attempt bind, and process termination at each durable phase.
- [x] Customer tests prove one provider create on the normal and replay paths and stable attention on multiple matches.
- [x] Return tests cover wrong Workspace, wrong actor, unpaid, delayed payment, complete but not reconciled, current plan, expired attempt, and lost browser response.
- [x] Hono tests prove strict payloads, owner authorization, typed conflict and activation mappings, safe return URLs, and `Retry-After`.
- [x] Browser-adapter tests use fake HTTP, clock, local storage, navigation, and announcements without depending on React effect order.
- [x] React tests prove persistent Activating state, no false success, accessible completion announcement, retry action, and safe removal of return query parameters.
- [x] Disposable PostgreSQL tests prove one active attempt per idempotency key, concurrent replay, customer uniqueness, and crash recovery.

## Provider and UX constraints

- [x] Configure and test the customer portal product catalog before paid plan changes are enabled.
- [x] Checkout and portal URLs are returned to the browser but never logged or persisted beyond the minimum durable provider identity needed for replay.
- [x] Use shared pricing and date facts rather than hardcoded plan copy.

## Scope boundaries

- [x] Do not build custom payment forms, invoices, refunds, coupons, taxes, or destructive customer repair.
- [x] Do not implement paid-seat reconciliation or final member UX.

## Fresh-task handoff

Implement after ticket 04 with `/implement`; use `/tdd` for idempotency, ambiguous customer creation, return verification, and activation UX; finish with `/code-review`; run uncached module, Hono, browser, React, database, typecheck, lint, test, and build checks.

## Completion evidence — 2026-08-28

- Workspace Billing now owns durable Checkout attempts, stable customer/session operation keys, exact metadata recovery, immutable replay conflicts, return observation, portal start, and the typed billing view. Checkout URLs remain response-only.
- Browser-owned keys are persisted before requests; bounded polling honors `Retry-After`, survives transient failures, strips return parameters, and never grants access from a redirect.
- Module, browser-adapter, Hono mapping, sandbox Stripe, concurrent PostgreSQL, full repository, production build, and real Chrome checks pass.
