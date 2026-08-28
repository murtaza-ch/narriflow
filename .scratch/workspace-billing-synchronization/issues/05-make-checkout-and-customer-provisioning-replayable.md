# 05 — Make Checkout and customer provisioning replayable

**What to build:** Let a Free or pending-payment Workspace start its first subscription once, recover an ambiguous Stripe customer or Checkout response, and show truthful activation progress until background reconciliation verifies the plan. Existing paid Workspaces change billing through Stripe's hosted portal.

**Blocked by:** [04 — Apply subscription health, access, and retention policy](04-apply-subscription-health-access-and-retention-policy.md).

**Status:** ready-for-agent

**Specification:** [Deepen Workspace Billing synchronization](../spec.md)

## Observable acceptance criteria

- [ ] The browser creates and stores a client Checkout idempotency key before its first start request.
- [ ] One durable Checkout attempt binds Workspace, actor, target tier, interval, catalog version, return destination, provider phase, session outcome, and expiry.
- [ ] Replaying the same key and immutable inputs returns the same live Checkout destination or terminal result without another customer or session creation.
- [ ] Reusing a key with different Workspace, tier, interval, or return facts returns a typed conflict and changes no billing state.
- [ ] Only an owner with billing capability may start Checkout, observe its return, or open the portal.
- [ ] Checkout is available only when the Workspace has no entitlement-bearing subscription or is pending its first payment.
- [ ] Existing paid Workspaces use a configured customer portal catalog for plan, interval, payment-method, invoice, and cancellation changes.
- [ ] Customer provisioning writes durable operation intent before the provider call and uses a stable provider idempotency key.
- [ ] A lost provider response retries the same operation while safe, then reconciles exact Workspace metadata before any new create.
- [ ] Exactly one recovered provider customer binds to the Workspace Billing Account.
- [ ] Multiple matching customers or a customer already bound elsewhere produce operator attention and no automatic merge or deletion.
- [ ] A lost database bind after customer creation can recover the same customer without creating another.
- [ ] Checkout creation uses the bound customer, immutable metadata, configured base price, and workspace-scoped return facts.
- [ ] Checkout return observation verifies the session belongs to the current Workspace and durable attempt.
- [ ] Return observation never writes a tier from the Checkout Session. It records the outcome, marks reconciliation due, and returns the current billing view.
- [ ] A short inline reconciliation may finish activation, but a slow result returns `activating` with `Retry-After` rather than holding the request open.
- [ ] Activation polling uses bounded jitter, survives transient request failure, and may continue after navigation or page close through the worker.
- [ ] The UI shows success only after the verified billing view is current. The old optimistic upgrade toast and direct confirmation endpoint behavior are removed.
- [ ] Incomplete or delayed payment remains pending, failed or expired Checkout leaves the prior plan unchanged, and retry starts or resumes safely.
- [ ] A canceled new Business Workspace stays pending with a clear Complete setup action and can switch away without losing other Workspaces.
- [ ] Portal return relies on delivery and current-state reconciliation and does not assume the owner changed anything.

## Public-interface and failure-injection tests

- [ ] Interface tests cover fresh start, replay, immutable conflict, concurrent start, active paid refusal, pending retry, Checkout expiry, and completed replay.
- [ ] Failure injection covers customer create timeout, create success before database bind, metadata lookup delay, Checkout create timeout, Checkout success before attempt bind, and process termination at each durable phase.
- [ ] Customer tests prove one provider create on the normal and replay paths and stable attention on multiple matches.
- [ ] Return tests cover wrong Workspace, wrong actor, unpaid, delayed payment, complete but not reconciled, current plan, expired attempt, and lost browser response.
- [ ] Hono tests prove strict payloads, owner authorization, typed conflict and activation mappings, safe return URLs, and `Retry-After`.
- [ ] Browser-adapter tests use fake HTTP, clock, local storage, navigation, and announcements without depending on React effect order.
- [ ] React tests prove persistent Activating state, no false success, accessible completion announcement, retry action, and safe removal of return query parameters.
- [ ] Disposable PostgreSQL tests prove one active attempt per idempotency key, concurrent replay, customer uniqueness, and crash recovery.

## Provider and UX constraints

- [ ] Configure and test the customer portal product catalog before paid plan changes are enabled.
- [ ] Checkout and portal URLs are returned to the browser but never logged or persisted beyond the minimum durable provider identity needed for replay.
- [ ] Use shared pricing and date facts rather than hardcoded plan copy.

## Scope boundaries

- [ ] Do not build custom payment forms, invoices, refunds, coupons, taxes, or destructive customer repair.
- [ ] Do not implement paid-seat reconciliation or final member UX.

## Fresh-task handoff

Implement after ticket 04 with `/implement`; use `/tdd` for idempotency, ambiguous customer creation, return verification, and activation UX; finish with `/code-review`; run uncached module, Hono, browser, React, database, typecheck, lint, test, and build checks.
