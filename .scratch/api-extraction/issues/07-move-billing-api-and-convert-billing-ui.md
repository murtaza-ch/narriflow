# 07. Move billing API and convert billing UI

**What to build:** Billing adapters and UI preserve checkout, quotes, seats, reconciliation and restricted-owner recovery on a separate API origin.

**Blocked by:** [04 - Wire API runtime and partition the catch-all](04-wire-api-runtime-and-partition-the-catch-all.md)

**Status:** done

**Suggested implementer:** Claude. The other pairing side reviews and returns findings to this owner.

Read [spec.md](../spec.md). It is the complete contract; the original brief/plan/reviews are not prerequisites. Claim this ticket before editing.

## Exact ownership

Paths are repo-relative. Every existing file below is exclusively assigned for this phase, including files that only need verification. A new `/**` directory includes its local tests/helpers, not adjacent directories. Read other files as evidence; do not edit them.

Existing files:

- `apps/web/app/(app)/_components/credits-menu.test.tsx`
- `apps/web/app/(app)/_components/credits-menu.tsx`
- `apps/web/app/(app)/_components/plan-limit-notice.tsx`
- `apps/web/app/(app)/_components/upgrade-visuals.tsx`
- `apps/web/app/(app)/_components/upgrade.browser.fixture.tsx`
- `apps/web/app/(app)/_components/upgrade.test.tsx`
- `apps/web/app/(app)/_components/upgrade.tsx`
- `apps/web/app/(app)/_components/usage-palette.ts`
- `apps/web/app/(app)/_components/usage.ts`
- `apps/web/app/(app)/integrations/_components/upgrade-tile-button.tsx`
- `apps/web/app/(app)/settings/billing/billing-plans.focus.fixture.tsx`
- `apps/web/app/(app)/settings/billing/billing-plans.focus.test.ts`
- `apps/web/app/(app)/settings/billing/billing-plans.test.tsx`
- `apps/web/app/(app)/settings/billing/billing-plans.tsx`
- `apps/web/app/(app)/settings/billing/loading.tsx`
- `apps/web/app/(app)/settings/billing/page.tsx`
- `apps/web/app/(app)/settings/usage/loading.tsx`
- `apps/web/app/(app)/settings/usage/page.tsx`
- `apps/web/app/api/[[...route]]/stripe-webhook-http.test.ts`
- `apps/web/app/api/[[...route]]/stripe-webhook-http.ts`
- `apps/web/app/api/[[...route]]/workspace-billing-routes.test.ts`
- `apps/web/app/api/[[...route]]/workspace-billing-routes.ts`
- `apps/web/lib/billing-browser.test.ts`
- `apps/web/lib/billing-browser.ts`
- `apps/web/lib/billing-plan-change.test.ts`
- `apps/web/lib/billing-plan-change.ts`
- `apps/web/lib/billing-view-model.test.ts`
- `apps/web/lib/billing-view-model.ts`
- `apps/web/lib/feature-upgrade-prompt.test.ts`
- `apps/web/lib/feature-upgrade-prompt.ts`
- `packages/services/src/billing.service.ts`
- `packages/services/src/workspace-billing-cutover.test.ts`
- `packages/services/src/workspace-billing-operator.test.ts`
- `packages/services/src/workspace-billing.db.test.ts`
- `packages/services/src/workspace-billing.sandbox.test.ts`
- `packages/services/src/workspace-billing.service.test.ts`
- `packages/services/src/workspace-billing.service.ts`
- `packages/services/src/workspace-billing.stripe-contract.test.ts`
- `packages/services/src/workspace-plan-change-stripe.test.ts`
- `packages/services/src/workspace-plan-change-stripe.ts`

New files/directories or reserved skeletons handed off by a blocker:

- `apps/api/src/domains/billing/**`
- `apps/api/src/types/billing.ts`
- `packages/api-client/src/billing/**`
- `packages/validators/src/api/billing.ts`

The chosen new endpoints for this ticket are the matching owner row in spec.md, "Endpoint and screen contracts added by extraction". All current endpoints/actions below retain their semantics unless that row explicitly changes transport. Fill only this domain's receipt-command module; current native receipts remain native.

## Endpoints, actions, pages and refresh sites

Rows retain their section/ordinal or exact source-line identifier from the independent inventory. Abbreviated table filenames are accompanied by the literal ownership manifest and exact source occurrences below. All action/page/fetch/refresh rows in owned files are in scope, including no-refresh callers and media navigation. Baseline observations do not override the spec's selected origins, route style, guest Bearer or new endpoints.

### Inventory 1.1 function `createBusinessWorkspaceAction(previous, formData)` (`useActionState`)

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `app/workspaces/new/actions.ts:42` | `createBusinessWorkspaceAction(previous, formData)` (`useActionState`) | `businessWorkspaceCheckoutActionSchema` built by `./checkout-request.ts` (`buildBusinessWorkspaceCheckoutRequest`, `recoverBusinessWorkspaceCheckoutFields`): `{name?, workspaceId?, interval, checkoutIdempotencyKey?}` | `billingService.isCheckoutConfigured`, `workspaceService.requireActor(..., "billing.manage")`, `workspaceService.createPendingBusinessWorkspace`, `billingService.startCheckout` (returnDestination `${origin}/settings/billing`, origin from `resolveCanonicalAppOrigin({configuredOrigin: NEXT_PUBLIC_APP_URL, environment: NODE_ENV})`), `setActiveWorkspaceForActor` | `executeSignedInActionWithInput` | `billingService.isCheckoutConfigured("business", interval)`; pending-workspace owner + status check (`workspace_checkout_state_invalid`) | `CreateWorkspaceState {error?, errorCode?, requestId?, checkoutUrl?, workspaceId?, workspaceName?, interval?, checkoutIdempotencyKey?}` (never throws; policy failure remapped to state) | sets active-workspace cookie | `app/workspaces/new/create-workspace-form.tsx:25` `useActionState`; effect does `window.location.assign(state.checkoutUrl)` (:28) | `POST /api/workspaces/business-checkout` (idempotency key in body; return-origin must come from API config `APP_URL`, not request) | billing (workspace create) |

### Inventory 2.B page/type row at inventory line 249

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/(app)/settings/billing/page.tsx` (88) | content.view L23 | `billingService.readBillingState` L25; `projectService.getUsageSummary` L26; `billingService.configuredTiers()` L75, `billingService.isConfigured()` L76 (sync config reads on the server) | `searchParams`: `checkout (return\|cancelled), session_id, plan, interval` | none | `BillingPlans{initialView,availableTiers,isConfigured,checkoutReturnSessionId,checkoutCancelled,canManageBilling,focusTier,requestedInterval}` | Existing `GET /api/billing/state`. **NEW**: `availableTiers`/`isConfigured` added to that response (or `GET /api/billing/config`); usage via `GET /api/workspace/usage`. `checkout/return` handled by existing `POST /api/billing/checkout/return`. |

### Inventory 2.B page/type row at inventory line 250

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/(app)/settings/usage/page.tsx` (52) | content.view L17 | `projectService.getUsageSummary` L18 | none | none | static server render (`StatTile`) | **NEW `GET /api/workspace/usage`** (shared with layout, billing, upload). |

### Inventory 3.2 row 112

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 112 | POST | `/webhooks/stripe` | stripe-webhook-http.ts:27 | `billingService.handleWebhook` |  | independent-trust: `stripe_signature` |  |  | plain Hono | P0 |

### Inventory 3.2 row 113

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 113 | POST | `/billing/checkout` | workspace-billing-routes.ts:75 | `billingService.startCheckout` | `checkoutRequestSchema` | browser-session: `billing.manage`, workspace |  | clientIdempotencyKey (body) | plain Hono | D7 |

### Inventory 3.2 row 114

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 114 | POST | `/billing/checkout/return` | workspace-billing-routes.ts:97 | `billingService.observeCheckoutReturn` | `checkoutReturnRequestSchema` | browser-session: `billing.manage`, workspace |  | Retry-After | plain Hono | D7 |

### Inventory 3.2 row 115

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 115 | POST | `/billing/portal` | workspace-billing-routes.ts:120 | `billingService.openPortal` |  | browser-session: `billing.manage`, workspace |  |  | plain Hono | D7 |

### Inventory 3.2 row 116

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 116 | GET | `/billing/state` | workspace-billing-routes.ts:132 | `billingService.readBillingState` |  | browser-session: `content.view`, workspace |  | Retry-After | plain Hono | D7 |

### Inventory 3.2 row 117

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 117 | POST | `/billing/plan-change/preview` | workspace-billing-routes.ts:139 | `billingService.previewPlanChange` | `planChangePreviewRequestSchema` | browser-session: `billing.manage`, workspace |  |  | plain Hono | D7 |

### Inventory 3.2 row 118

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 118 | POST | `/billing/plan-change/confirm` | workspace-billing-routes.ts:154 | `billingService.confirmPlanChange` | `planChangeConfirmRequestSchema` | browser-session: `billing.manage`, workspace |  |  | plain Hono | D7 |

### Inventory 3.2 row 119

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 119 | POST | `/billing/plan-change/payment` | workspace-billing-routes.ts:169 | `billingService.readPendingPlanChangePayment` |  | browser-session: `billing.manage`, workspace |  |  | plain Hono | D7 |

### Inventory 3.2 row 120

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 120 | POST | `/billing/plan-change/cancel` | workspace-billing-routes.ts:177 | `billingService.cancelScheduledPlanChange` |  | browser-session: `billing.manage`, workspace |  |  | plain Hono | D7 |

### Inventory 3.2 row 121

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 121 | POST | `/billing/reconcile` | workspace-billing-routes.ts:185 | `billingService.reconcileCurrentState` |  | browser-session: `billing.manage`, workspace |  | Retry-After | plain Hono | D7 |

### Inventory 5.7 refresh/fetch row at inventory line 813

| file:line | Trigger | Call | Refreshes |
| --- | --- | --- | --- |
| `(app)/settings/billing/billing-plans.tsx:345` (in `refreshAfterPlanChange`) | After plan-change confirm | `POST /api/billing/reconcile` (:341; also :424) | `/settings/billing` server props plus local `setView(workspaceBillingViewSchema.parse(...))` |

### Inventory 5 exact file occurrences: apps/web/app/(app)/settings/billing/billing-plans.tsx

```text
136: const response = await fetch("/api/billing/state", { cache: "no-store" });
162: const response = await fetch("/api/billing/checkout/return", {
212: const response = await fetch(url, {
248: window.location.assign(
285: window.location.assign(await postForUrl("/api/billing/portal"));
296: const response = await fetch(`/api/billing/plan-change/${path}`, {
341: const response = await fetch("/api/billing/reconcile", { method: "POST" });
345: router.refresh();
362: window.location.assign(paymentUrl);
411: window.location.assign(paymentUrl);
424: const response = await fetch("/api/billing/reconcile", { method: "POST" });
```

### Inventory 1.4 function `queueTranscriptionFormAction(formData)` (alias `queueGenerationFormAction` :187, no callers), caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:156` | `queueTranscriptionFormAction(formData)` (alias `queueGenerationFormAction` :187, no callers) | `formData`: `projectId`, `idempotencyKey` (default `randomUUID()`), content pack via `readContentPackFromForm`, `readLanguageCodeFromForm` (`app/(app)/upload/_lib/content-pack-form.ts`) | `projectService.triggerGeneration(appUser, projectId, {contentPack, forceRegenerate:false, languageCode}, idempotencyKey)` | `executeProjectAction(projectId,"processing.consume")` | credits/length via `ProcessingUsageError` from service; caught -> **`redirect("/projects/:id")`** (page shows limit + upgrade) | `void`; throws on missing `projectId` | `revalidatePath("/projects/:id")`; `redirect` on plan limit | `projects/[projectId]/processing-panel.tsx:487` and `projects/[projectId]/page.tsx:869` (`AuthenticatedActionForm action=`) | existing `POST /api/projects/:id/generate` (route.ts:448, verify parity: contentPack/languageCode/idempotency) ; plan-limit becomes a typed `ApiError` (`code`, `details`) the client renders instead of redirecting | projects |

### Inventory 1.4 function `applyProjectBrandProfileFormAction(formData)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:189` | `applyProjectBrandProfileFormAction(formData)` | `brandProfileProjectApplicationSchema` `{projectId, profileId, templateId\|null}` | `brandProfileService.applyToProject(actor, projectId, {profileId, templateId})` | `executeProjectActionWithInput(projectId,"content.edit")` | none | `void` / failure | `revalidatePath("/projects/:id")` | `projects/[projectId]/project-brand-picker.tsx:55` | `PUT /api/projects/:projectId/brand-profile` (or reuse `/projects/:id/campaign-operations/apply-brand-profile`, route.ts:930, which applies to selected clips; different semantics, verify) | brand-kit / projects |

### Inventory 1.4 function `regenerateClipsFormAction(formData)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:222` | `regenerateClipsFormAction(formData)` | `projectId`, `idempotencyKey`, content pack | `clipService.regenerateClips(appUser, projectId, idempotencyKey, contentPack)` | `executeProjectAction(projectId,"processing.consume")` | `ProcessingUsageError` -> `redirect("/projects/:id")` | `void` | `revalidatePath`; `redirect` on plan limit | `processing-panel.tsx:449`, `projects/[projectId]/page.tsx:940` | existing `POST /api/projects/:id/clips/regenerate` (`clip-generation-http.ts:11`, verify parity) | projects |

## Acceptance criteria

- [x] Nine billing routes plus Stripe raw webhook preserve provider receipts/fencing/checkout keys/quotes/seat and activation state.
- [x] New-Workspace checkout uses identity-only admission and existing pending Workspace recovery and returns explicit selection/checkoutUrl.
- [x] Both pages and upgrade/credit/account integrations use typed safe config and scoped data; no entitlement inferred from return navigation.
- [x] Billing return/portal URLs use WEB_ORIGIN; safe 202 activation polling and plan-change recovery retained; unavailable optional Stripe config degrades as today.
- [ ] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun test apps/api/src/domains/billing
bun run test:workspace-billing:db
bun test apps/web/lib/billing-browser.test.ts apps/web/lib/billing-plan-change.test.ts
bun run --cwd apps/api typecheck
```

Verify the changed flow in the running Next app against the separate API origin. Follow the repo's runtime/browser verification guidance; record steps, result and origin pair. Do not treat compilation as browser evidence.

## Comments

Claimed and implemented by Claude (Sonnet 5.5), 2026-10-29. Paired review not run by the implementer (last acceptance box left open for the orchestrator). Browser verification against a running Next app was NOT performed (see Evidence).

### Contract for later tickets
- **API** (`apps/api/src/domains/billing`): `createBillingRoutes({billingService, webOrigin})`, `createBillingWebhookRoutes({acceptDelivery})`; admission table has the nine controls, `POST /workspaces/business-checkout` (`signed_in`), `POST /webhooks/stripe` (`provider_signature`). Return/portal destinations are `${WEB_ORIGIN}/settings/billing`, never from the request. `GET /billing/state` now returns `{view, availableTiers, isConfigured}` (`billingStateResponseSchema`) and keeps `Retry-After: 2` while activating. Invalid input is now the common 400 `invalid_input` (was `validation_failed` / `invalid_checkout_return`); the screen branches on domain codes only, which are unchanged. Checkout/plan-change retries keep their native body identities (`clientIdempotencyKey`, `quoteId`, `checkoutIdempotencyKey`); no `Idempotency-Key` header is required, no billing receipt-command module exists.
- **New-Workspace checkout**: `BillingService.startBusinessWorkspaceCheckout` (services, mine) = old `createBusinessWorkspaceAction` logic: config check, resume (`requireActor(... "billing.manage")`, owner + `pending_payment`, else `workspace_checkout_state_invalid`) or `createPendingBusinessWorkspace`, then `startCheckout`. 200 `{checkoutUrl, checkoutIdempotencyKey, interval, selection:{workspaceId, workspaceName}}`. Any failure after the inputs are known carries `details.recovery = {workspaceId?, workspaceName?, interval, checkoutIdempotencyKey}` (same status/code as before; unexpected errors become 503 `workspace_checkout_failed`, logged without the cause). The form resubmits `{workspaceId, interval, checkoutIdempotencyKey}` from `recovery`. The API no longer sets the active Workspace: the client must adopt `selection.workspaceId` (runtime.selectWorkspace / `POST /api/session/workspace-selection`) before navigating to `checkoutUrl`. Known limit (unchanged from the action): a lost first response leaves a pending Workspace the form cannot name; a retry creates another (owner cap of 25 bounds it). No receipt exists for it.
- **Client** (`@narriflow/api-client/billing`): `billingStateQueryOptions({transport, scope})` (key `nf/user/ws/billing/state`, staleTime 0, returns `retryAfterSeconds`), `readBillingState`, `createBillingActions(transport, scope)` (`startCheckout`, `observeCheckoutReturn`, `openPortal`, `previewPlanChange`, `confirmPlanChange`, `cancelPlanChange`, `pendingPaymentUrl`, `reconcile`), `startBusinessWorkspaceCheckout(transport, identityScope, input)`, `invalidateBillingDependents(qc, scope, {includeState})`, `billingKeys`.
- **Web**: `BillingPlans` keeps its props and adds `api: BillingPlansApi` and `onViewChange`; `billing-screen.tsx` / `usage-screen.tsx` are the data views (pages are data-free shells). Stripe return/portal/payment navigation unchanged; entitlements refresh only when a verified view changes plan/interval/status/access/seats (`billingViewChangesEntitlements`), never on return.

### Requests for other owners
- **05**: export `workspaceBootstrapQueryOptions` (and ideally a usage selector) from the Workspace client with query key `scopedKey(scope, "workspace", "bootstrap")`. Until then `apps/web/app/(app)/_components/usage.ts` (mine, replaces the server `getCachedUsageSummary`) holds an identical local factory and `useWorkspaceBootstrap(scope)`; 31 should swap it for 05's and delete mine. Billing/Usage read `capabilities["billing.manage"]` (was `role === "owner"`) and `usage` from that response.
- **06**: `app/(app)/layout.tsx` still imports the deleted `getCachedUsageSummary` (only remaining web compile error from this ticket). `app/workspaces/new/{actions,create-workspace-form}.tsx` is yours: call `startBusinessWorkspaceCheckout` (no Workspace scope), adopt `selection`, then `window.location.assign(checkoutUrl)`; feed `error.details.recovery` into `recoverBusinessWorkspaceCheckoutFields`-style state. `checkout-request.ts` helpers stay usable.
- **04/31**: `packages/api-client/package.json` needs `"./billing"` (or `"./*"`) in `exports`; web imports `@narriflow/api-client/billing` through the tsconfig `paths` today. The root `src/index.ts` exports only `createBillingClient`; re-export the billing queries/actions if you prefer root imports. `apps/web/lib/authenticated-request-inventory.ts` still lists the nine billing rows as baseline data (31 deletes it).
- **31**: `billingService.validateConfiguration({surface:"web"})` stays at API startup (04); delete web `billing-browser`/`billing-plan-change` only if they lose their callers (they still have them).

### Deviations / decisions
- Old `workspace-billing-routes.ts`, `stripe-webhook-http.ts` and their tests are deleted from `apps/web/app/api/[[...route]]` (moved to `apps/api/src/domains/billing/{routes,webhooks}.ts`; tests rewritten, same cases plus admission, origin and recovery cases). Working-tree deletions only; nothing staged or committed.
- Added `packages/services/src/billing-business-checkout.test.ts` (new file next to my service change; not in the manifest list) and `apps/api/src/domains/billing/test-support.ts` (billing-only composition around the real middleware chain, so these tests do not depend on other domains' in-flight routes).
- Stripe `webhook` body is read once with `c.req.text()` (original bytes) after the 1 MiB webhook limit; the failure log is `{level, message, errorCode}` only.

### Evidence
- `bun test apps/api/src/domains/billing` -> 21 pass (admission: signed-out 401 for every route, member without `billing.manage` 403 on all seven mutations while `GET /billing/state` is 200, removed selection 409 before the service; hostile Host/forwarded headers ignored; 202/200 return contracts; plan-change input strictness; Stripe raw bytes preserved, `missing_signature`/`invalid_signature`/500 mapping, mounted without a session).
- `bun test packages/api-client/src/billing` -> 11 pass; `bun test packages/services/src/billing-business-checkout.test.ts` -> 8 pass.
- `cd apps/web && bun test lib/billing-browser.test.ts lib/billing-plan-change.test.ts lib/billing-view-model.test.ts "app/(app)/settings/billing" "app/(app)/_components" lib/feature-upgrade-prompt.test.ts` -> 62 pass (fixture covers focus recovery, quote review/confirm/reconcile call order through the real client, return observation following only the API-verified state).
- `.scratch/api-extraction/db-gate.sh bun run test:workspace-billing:db` -> 16 pass, exit 0; `... test:processing-usage:db` -> 31 pass, exit 0 (local Postgres, not Neon).
- Typecheck: `packages/api-client`, `packages/validators`, `packages/services`, `apps/api`: no error in any file of this ticket (remaining errors are others': `workspace/routes.ts`, `rest/routes.ts`, `reviews/guest-replay-child.ts`, `brand/queries.ts`, `clips-commands.ts`). Web typecheck: only `app/(app)/layout.tsx` (06) reports a billing/usage symbol (`getCachedUsageSummary`).
- `bunx biome check` on all owned paths: clean. `bun run --cwd apps/api test:inventory`: no billing/stripe/business-checkout problem (the other problems belong to in-flight domains).
- Runtime (API origin only): started `apps/api` on `:4010` with `WEB_ORIGIN=http://localhost:3000` and the dev env files read-only; `GET /api/billing/state` -> 401 envelope with CORS for `http://localhost:3000`, 403 for `http://evil.example`; `POST /api/webhooks/stripe` -> 400 `missing_signature` and, with a bad signature, 400 `invalid_signature` from the real `billingService.handleWebhook`; `POST /api/workspaces/business-checkout` unauthenticated -> 401; preflight 204 with the first-party header set. Origin pair: web `http://localhost:3000` / API `http://localhost:4010`.
- NOT done: the signed-in browser run (Clerk login, Stripe test Checkout return, portal, plan change) against `next dev` + the API. The web project still has transitional compile errors from other tickets and needs an interactive Clerk session; ticket 32 must run: Checkout start/return/activation polling, portal, plan-change preview/confirm/cancel/payment, restricted-owner recovery, New-Workspace checkout, and a real Stripe test-mode webhook redelivery against `A/api/webhooks/stripe` (new endpoint secret).
