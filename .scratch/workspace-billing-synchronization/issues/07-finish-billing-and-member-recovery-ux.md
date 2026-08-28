# 07 — Finish billing and member recovery UX

**What to build:** Give owners and members one coherent billing experience for current, activating, retrying, payment-action, restricted, and operator-attention states. Every message and control must match durable billing truth, expose one useful next action, and avoid provider jargon or false success.

**Blocked by:** [05 — Make Checkout and customer provisioning replayable](05-make-checkout-and-customer-provisioning-replayable.md); [06 — Converge paid seats from committed membership](06-converge-paid-seats-from-committed-membership.md).

**Status:** ready-for-agent

**Specification:** [Deepen Workspace Billing synchronization](../spec.md)

## Observable acceptance criteria

- [ ] Billing settings show verified plan, interval, processing usage, renewal or end date, provider status in product language, health, and last successful synchronization.
- [ ] Business billing shows desired and synchronized additional paid seats and explains that the owner seat is included and Viewers are free.
- [ ] Current state presents the plan and one appropriate owner action without redundant success messaging.
- [ ] Activating state persists across refresh, polls with server guidance, announces completion once, and says the page may be left safely.
- [ ] Retrying state says current verified access is unchanged and does not ask the owner to repeat payment.
- [ ] Payment-action state shows the exact grace deadline, explains which capabilities continue, and offers the billing portal as the primary action.
- [ ] Cancel-at-period-end state shows the exact access end date and a portal action to review or reverse cancellation.
- [ ] Restricted state explains that processing, publishing, API, MCP, and new billable collaboration are paused while owner view, download, and billing repair remain available.
- [ ] Operator-attention state uses neutral copy, preserves verified access, provides a safe portal or support action, and exposes no internal conflict class to non-owners.
- [ ] Failed or expired first Checkout clearly offers a safe retry without implying payment succeeded.
- [ ] Non-owners see read-only plan and Workspace state and never receive Checkout, portal, retry, or repair controls.
- [ ] Existing paid plan cards direct owners to manage the current subscription rather than creating another Checkout subscription.
- [ ] Free and pending Workspaces retain first-subscription Checkout actions only when billing catalog and capability checks allow them.
- [ ] Member settings show billable role impact from the shared validated catalog rather than hardcoded browser confirmation strings.
- [ ] Member actions remain responsive during seat synchronization and show one persistent owner-visible synchronization line instead of per-action provider errors.
- [ ] New billable additions are disabled with an explanation during restricted or attention states; safe Viewer, demotion, removal, portal, and download actions remain usable.
- [ ] All dates and durations use shared formatting. Billing chrome uses Blueline semantic tokens, hairline structure, and one solid ultramarine action per view.
- [ ] Status updates use an accessible live region with bounded announcements. Polling does not flood screen readers or toasts.
- [ ] Focus returns to the originating control after a recoverable inline error and moves to the persistent status summary after activation or restriction.
- [ ] Raw Stripe errors, IDs, event types, attempt counts, internal status names, Checkout URLs, and portal URLs never appear in rendered copy or analytics payloads.
- [ ] HTTP adapters return stable typed billing views and actions; React does not derive subscription, retention, seat, retry, or conflict policy.

## Browser and contract tests

- [ ] React tests cover every health state, owner and non-owner controls, plan changes, dates, seat counts, disabled reasons, focus, and live-region behavior.
- [ ] Browser-adapter tests cover repeated activation polling, `Retry-After`, transient network failure, navigation away, return later, successful activation, expired Checkout, and portal return.
- [ ] Member UX tests cover Viewer invite, billable invite copy, billable promotion, seat retry, attention blocking, safe demotion, and safe removal.
- [ ] Hono tests prove typed reads and actions, owner authorization, workspace isolation, strict validation, stable status codes, and no message-dependent mapping.
- [ ] A real-browser checklist covers Free checkout, lost return response, delayed activation, active paid portal, cancellation-at-period-end return, past-due banner fixture, restricted collaborative fixture, billable member change, and non-owner read-only view.
- [ ] Accessibility checks cover keyboard-only operation, visible focus, status semantics, announcement rate, button labels, and color-independent state cues.

## Compatibility and design constraints

- [ ] Remove obsolete upgrade toasts, dead confirmation polling, hardcoded seat-price strings, and competing billing-state derivation once the new views pass.
- [ ] Preserve current usage meters, plan information, Workspace navigation, and member role permissions outside billing-state changes.
- [ ] Do not add a hidden old billing page, fallback component, or feature selector.

## Scope boundaries

- [ ] Do not redesign unrelated settings, create an operator dashboard, or build custom Stripe-hosted screens.
- [ ] Do not change the subscription or seat policies accepted in the specification.

## Fresh-task handoff

Implement after tickets 05 and 06 with `/implement`; drive billing and member views through `/tdd`; finish with `/code-review`; run uncached React, browser-adapter, Hono, accessibility, real-browser, typecheck, lint, test, and build verification.
