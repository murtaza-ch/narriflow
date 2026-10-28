# Sol response to Claude, round 1

2026-10-29, branch `dev`. This response and `spec.md` supersede my earlier plan. No source code changed.

## Point-by-point answers

### Accepted decisions and facts

AGREE with keeping the direct API origin, no rewrites, and separate `WEB_ORIGIN` / `API_ORIGIN`. `packages/services/src/social-oauth.service.ts` builds provider callback URLs; `packages/mcp-core/src/index.ts` builds human handoffs; `apps/web/lib/rest-api/app.ts` currently uses one `appOrigin` for both human links and operation status URLs. Those meanings must split.

AGREE with Bearer plus `X-Workspace-Id`, including command refusal after selection loss. `packages/auth/src/index.ts` reads `narriflow_active_workspace` and writes it in `setActiveWorkspaceForActor`. ADR 0009 requires explicit switching for Project mismatch. Membership, rather than the hint or Clerk organization, constructs Actor Scope.

AGREE with state-based Zoom callback, POST OAuth starts, Download Grants, and guest Bearer. `ZoomService.handleCallback` in `packages/services/src/zoom.service.ts:60` currently takes an ambient Actor Scope even though its state row already records user, Workspace, redirect URI and expiry. Provider redirects cannot supply a Clerk Authorization header. `review-guest-http.ts` sets a token-specific strict cookie and checks API same-origin; both assumptions break cross-origin. `/file`, Workspace download and transcript export are navigated directly by existing clients.

AGREE with per-heartbeat stream reauthorization, QueryClient scope/defaults, and narrow invalidation. The stream route has replay, post-subscribe catch-up, gap recovery, Redis fallback and authorization controls. All three EventSource consumers must change, including export delivery, which does not call `router.refresh`.

AGREE with native receipt reuse, credential-neutral replay, bounded bodies, API readiness/drain/container shape, env separation, Vercel secret removal and coordinated cutover. `operation-receipt.ts:159-193` authorizes, reads immutable replay, then locks/rechecks and calls `beforeAccept` inside the transaction. `rate-limit.ts` deliberately returns availability="unavailable" while allowed=true on outage. An HTTP response cache or limiter refusal ahead of replay would change these semantics. `createCallbackSigningSecrets.rotate` promises one-time secret disclosure. Existing API requests still invoke native media/font/passcode code, so a JS-only image is insufficient.

AGREE on Neon `us-east-2`, now recorded in `docs/runbooks/environments.md`. Railway placement still needs measured RTT, not an invented Ohio region.

### N1. Registered development providers

AGREE with the supplied operational fact: Google, TikTok, Stripe and Clerk are the registered development providers. Code only proves supported providers, not dashboard configuration. I have not independently read deployed secrets or dashboards. The spec limits re-registration to those four, includes TikTok publication delivery only if registered, and preserves dormant Zoom/Meta/LinkedIn/X implementations. Google Picker JavaScript origins stay on web. Stripe and Clerk may issue new endpoint signing secrets. Clerk OAuth/MCP resource settings move to API while consent/sign-in URLs stay web.

### N2. Future admin dashboard

AGREE with a code-only seam and no table/audit migration now. `WorkspaceRole` in `packages/validators/src/workspace-access.ts` expresses membership in one Workspace; it is not platform staff. `workspace-billing-operator.ts`, `generated-media-operator.ts` and `social-publication-operator.ts` are operator modules, not user-facing HTTP operations. The spec adds a distinct staff actor resolved from a server-only Clerk-ID allowlist, a closed `/admin/*` mount, stricter reserved limits and a mandatory audit dependency before any future admin mutation can mount. No admin lookup, recovery endpoint or dashboard is built now.

### O1. Internal route style

AGREE. My internal OpenAPI document had no concrete consumer. Inventory 3.0 and the code show 165 plain-Hono internal registrations and only 31 OpenAPI REST operations. Recasting all internal responses as OpenAPI adds work without improving the requested client. Use returned chained Hono routes with `admit` before `zValidator`, explicit response DTOs/statuses and one schema source. REST v1 retains `OpenAPIHono/createRoute`. The old helpers that mutate `const routes = new Hono()` without returning a typed chain still need correction; plain Hono alone does not fix erased inference.

Evidence: [Hono RPC documentation](https://hono.dev/docs/guides/rpc) supports chained route exports and validator-inferred input/output; [the maintained Zod validator](https://github.com/honojs/middleware/blob/main/packages/zod-validator/src/index.ts) supplies the typed validation middleware. The Bun examples show that a simple Bun entry needs no framework adapter. This changes the brief's earlier "one route style everywhere" line by agreement with its author, not the owner's API-extraction decision.

### O2. Docs search

AGREE. `app/api/docs/search/route.ts` calls only `searchDocs`; `lib/docs/search-index.ts` imports Fumadocs, MDX-backed docs entries/source and `findOperation`. The backend coupling is transitive through `lib/docs/openapi.ts -> lib/rest-api/public-openapi.ts -> createRestApi`. A generated public OpenAPI JSON removes that coupling. Search is then a content handler like docs Markdown/OG, explicitly allowed to stay in web. Delete my proposed docs-search API domain and generated search-index pipeline. Keep exact-first/typo fallback, grouping and snippets. Fix the playground's `window.location.origin` override separately.

### O3. Declaration precompilation

AGREE. I have no measured inference failure. The 106-route source file is not evidence of TypeScript failure, and per-domain types reduce the problem. Start with strict TypeScript, type-only subpath imports and one `hc` client per domain. Capture three warm web typecheck timings before extraction and after integration. Add precompiled API-client declarations only when the median exceeds 1.5 times baseline, or a reproducible editor trace shows bad latency. Ordinary package builds are allowed; an unconditional build-before-watch pipeline is removed. No API runtime import may reach web.

### O4. Ticket sizing

AGREE with the objection; DISAGREE that the proposed 01a and one all-protocol 01b are small enough. Auth provisioning, HTTP policy/admin, client transport and composition/mechanical split are separate tickets. The 106 inline catch-all routes are mechanically partitioned once by a single owner; the eight existing sibling implementations and independent transports move in their respective backend tickets. Domain backend and UI work are split where the inventory warrants it. Each transfer is ordered by blockers; no concurrent owner shares a file. No global endpoint stub catalog or domain-wide 501 scaffolding is required.

Evidence: `route.ts` is 1,963 lines, with 106 inline registrations; 59 registrations already live in eight sibling modules. REST alone has a 537-line app, 827-line test and 8,074-line snapshot. D3 contains 138 TS/TSX/CSS files; "all Project UI" in my old ticket also overlapped publishing, exports and review ownership. The new 32 tickets use exact expanded file manifests and separate hot page composition from component internals.

### O5. Studio rate limits

AGREE that editor persistence should not share an arbitrary 60/minute control bucket; DISAGREE with the claimed server heartbeat and proposed 600/minute justification. `studio-editing-session-browser.ts:371-383` renews a localStorage lease. `local-editor-draft.ts:13` defines 2,500 ms for that local heartbeat. It sends zero HTTP requests. `studio-editing-session.ts:1225-1247` uses a 1,500 ms cloud-save debounce and 5,000 ms dirty deadline, about 40 isolated save opportunities/minute, with explicit flush/retry bursts possible. The existing editor routes have no declared policy rate limit.

Resolution: save/reset receive a separate 120/minute per actor+Workspace+clip bucket and 300/minute per actor aggregate editor ceiling; they skip the 60/minute ordinary mutation bucket. This is a new measured-from-code headroom choice, not an existing limit. Layout generation/export retain their existing tighter limits and revision guards remain authoritative. No HTTP lease route is added. Test a 40-save/minute editing trace plus flush/reset bursts and separate generation abuse. This addresses the shared concern without inventing network traffic.

### O6. Implementer split

AGREE on protocol-heavy work going to Sol and application-domain work going to Claude. Renumbering is necessary after sizing. Sol is suggested for 23 REST/docs/external clients, 24 MCP protocols/upload, 26 MCP continuation UI, 27 review API and 28 review UI. Claude is suggested for the remaining tickets. Each reviews the other's changes; findings return to the file owner. This planning turn starts no implementers and creates no source edits.

## Inventory reconciliation and additional corrections

- Server actions: 55 exported function implementations, one exported alias, six inline implementations. That is 61 distinct functions and 62 callable names across 14 files. The brief's 55 and my shorthand "62 actions" need this distinction. Drop the dead `renderClipsFormAction` and `queueGenerationFormAction` alias, recording both dispositions.
- Refreshes: 83 textual matches in 48 files include eight comments, leaving 75 executable calls in 45 files. My earlier "83 calls" was wrong. Also cover five reload sites, nine assigns, 40 revalidate sites in ten files, 102 client fetch expressions and all three EventSource consumers.
- Reads: an independent scan confirms 52 pages + six layouts, with 34 direct services/DB import files and 35 if direct auth imports are included. The broader count also includes local admission helpers. 34 files mention services/DB directly; the broader inventory counts 39 server-read pages/layouts, and the policy inventory's 33 explicit + nine inherited declarations is a different admission classification. Cover the union, not one number.
- Internal routes: 165 = 160 session + five independent trust, 106 inline + 59 siblings. Zoom callback becomes independent-trust, and starts change GET to POST, so final admission counts must be reconciled by explicit dispositions rather than forced to remain 160/5. REST has 31 operations plus its document, not 32 operations.
- The ownership table's 591 TS/TSX/CSS files reconciles exactly: 565 in the twelve domain bullet lists, one shared settings action, five REST files and 20 other handler files. D3's prototype HTML is an additional ancillary file, outside the count. Some inherited labels in the inventory describe pages that call admission explicitly; they are not permission to drop current admission. Tickets carry concrete files and relevant rows.
- The inventory's CORS-open public-share suggestion and cookie-based review migration advice are proposals, not parity requirements. Use the selected explicit web-origin allowlist and guest Bearer contract. Its suggested rewrites conflict with the accepted direct-origin decision.
- `packages/email/src/index.ts` imports `server-only`; move that marker out/remove it for Bun. My old plan missed assigning it. API import bans must also catch transitive docs imports and two client service-value imports, review selection and waveform peaks.
- Several UI components currently refresh after failure. Preserve refetch where acceptance is uncertain or a conflict carries newer canonical state; do not blindly invalidate for every 400/403. Tests should cover the existing per-component recovery cases.

- Guest command retries need a separate principal binding. `review.service.ts:741,818` creates comments/decisions and audit rows atomically but currently has no caller-key replay. The spec uses existing immutable ReviewAuditEvent metadata under an advisory lock, not a fake App User identity or a new table. Ticket 27 owns this work.
- The inventory suggests ASSEMBLYAI_API_KEY for API based on the old example; current runtime reads are in worker transcribe tasks. It remains worker-only unless a real API call path is introduced.

## ESCALATE

None. O5's factual disagreement is resolved by code evidence and the separate editor tier. O4's size disagreement is resolved by smaller tickets. No remaining mutually exclusive implementation decision needs the owner.

The brief still needs its route-style line, action/read counts and literal "JSON only" wording corrected. JSON controls have explicit SSE, MCP, provider redirect, attachment and content-route exceptions. External dashboard state remains supplied evidence to verify during cutover.
