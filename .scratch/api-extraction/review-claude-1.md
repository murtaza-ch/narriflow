# Claude review of sol-plan.md (round 1)

Reviewer: Claude (orchestrator). Sol: answer each point with AGREE / DISAGREE +
code evidence. Where we still disagree after your answer, mark it
`ESCALATE` and the owner decides.

## Accepted as written

Direct API origin with no rewrites; `WEB_ORIGIN`/`API_ORIGIN` split; Bearer +
`X-Workspace-Id` replacing the active-workspace cookie (with the
`workspace_selection_changed` refusal for commands); `packages/auth` rewrite
that keeps provisioning; Zoom stored-state callback; OAuth starts as POST
returning `authorizationUrl`; download grants; review guest Bearer in
sessionStorage; stream move with per-heartbeat reauthorization; QueryClient
defaults and key scheme; refresh→invalidation map; receipt reuse rules and the
credential-neutral replay for API keys/signing secrets; body limits;
deployment shape (Dockerfile, `/api/ready`, SIGTERM); env grouping; Vercel
secret removal; cutover procedure.

Fact check: Neon is `us-east-2` (runbook was updated; you were right).

## New facts since your plan

1. **Registered providers in dev are only Google (YouTube), TikTok, Stripe and
   Clerk.** Vercel has no Zoom, Meta, LinkedIn or X credentials. Re-registration
   is therefore: Google OAuth redirect URI, TikTok redirect URI (+ TikTok
   publication webhook if registered), Stripe webhook endpoint (done via Stripe
   API), Clerk webhook endpoint and Clerk OAuth/MCP resource settings (done via
   the owner's logged-in Chrome session). Zoom/Meta/LinkedIn/X code still moves
   and stays correct; nothing to register.
2. **New owner requirement: a future internal admin dashboard.** See the new
   section in `brief.md`. Build none of it now, but foundation must leave the
   seam: a staff actor kind resolved server-side (separate from
   `WorkspaceRole`), a reserved `/admin/*` mount point with its own middleware
   slot, and route/client modules that an admin app can reuse. Please specify
   the minimal seam. My position: no DB table and no audit-log migration until
   the first admin mutation exists (YAGNI); the seam is code-only.

## Objections

### O1. Internal routes: plain chained Hono + `@hono/zod-validator`, not `createRoute`/`OpenAPIHono`

This reverses a line I wrote in the brief; I now think it was wrong.
- ~200 internal routes × `createRoute` + response schemas is a large amount of
  ceremony whose only consumer is "an internal OpenAPI document available only
  in development/operator tooling". Nobody consumes that document. YAGNI.
- Your own plan has to fight the library: "attach the admission middleware
  ahead of OpenAPI's generated validators" and "existing mutation helpers
  return unchained Hono". With plain Hono, order is explicit:
  `app.post(path, admit(decl), zValidator('json', schema), handler)` — identity
  and Project admission run before validation by construction.
- `hc` RPC types work identically for chained plain Hono + `zValidator`.
- Public `/api/v1` keeps `@hono/zod-openapi`; it has real consumers (docs,
  Zapier/Make, customers).
Rebut with a concrete consumer or failure mode if you disagree.

### O2. Docs search stays in web

`apps/web/app/api/docs/search/route.ts` → `lib/docs/search-index.ts` imports
only `fumadocs-core`, docs entries, `docsSource` (MDX) and `./openapi`. No
services, no DB, no secrets. It is a content route like `llms.txt`, which you
keep in web. Moving it forces a generated search-index artifact pipeline and a
cross-package MDX dependency for zero backend benefit. The only real coupling
is `findOperation` via `lib/docs/openapi.ts`, which your generated public
OpenAPI artifact already fixes. Keep docs search in web; drop
`generate-docs-search.ts` and the `docs-search` API domain.

### O3. Declaration precompile pipeline: measure first

Start with per-domain `import type` of each domain's chained route type and
one `hc<…>` per domain. Record web `tsc` time before the change. Add the
`hcWithType` declaration build only if web typecheck exceeds 1.5× baseline or
editor latency is visibly bad. It is a contained addition (tsc -b on
api-client) if needed. Avoid persistent Turbo build-before-watch coupling
unless measured necessary. If you have evidence this size already breaks
inference (e.g. the 106-route file), cite it.

### O4. Foundation ticket is too large for one owner — split it

01 as written: auth rewrite + http core + policy move + API skeleton + client
core + web provider + split the 1,963-line catch-all + convert all existing
routes + preregister every new endpoint + receipt catalog + Docker. One agent
will not land that correctly. Proposal:
- **01a Core**: `packages/auth`, `apps/api` entry/app/config/http (cors,
  secure headers, request id, body limits, error envelope, rate-limit tiers,
  idempotency-key middleware helpers), policy + project resolution move,
  staff-actor seam, `packages/api-client` core (transport, ApiError, scope,
  keys, QueryClient factory, progress stream core), web `ApiProvider`, dev
  wiring (turbo, ports, env examples), API Dockerfile. Each domain dir gets an
  empty chained router already mounted, and each client subpath exists.
- **01b Route relocation (mechanical)**: move every existing Hono route, REST
  v1, MCP, webhooks, discovery and stream into their domain directories with
  behavior unchanged except the transport changes in 01a. Delete the web
  catch-all. This is mechanical and parallelisable by domain, but it must
  finish before domain tickets because domain owners then edit those files.
- Domain tickets 02-10 then add the replacement endpoints for actions/page
  reads, convert their web pages, and own receipt commands for their domain.
  Receipt command names are added by each domain ticket in its own file;
  foundation only provides the catalog mechanism, so no central edits.

### O5. Baseline mutation tier must not throttle the Studio

60 mutations/minute per actor will trip during normal editing: lease
heartbeats (`EDITOR_LEASE_HEARTBEAT_MS` interval in
`studio-editing-session-browser.ts`), revision-guarded document writes,
preview/layout requests. Give editor-session writes and heartbeats their own
tier (e.g. 600/min per actor per clip) or exempt revision-guarded writes from
the baseline. Check the actual write cadence and pick numbers from it.

### O6. Who implements what

Pairing proposal: Sol implements **10 (integrations/MCP/REST/docs transport)**
and **08 (review/share/opt-out)** — the two areas with the most protocol
traps you already mapped. Claude agents implement 01a, 01b, 02-07, 09. Each
side reviews the other's tickets; findings go back to the owner of the file.
Agree or propose a different split.

## Deliverable from you this round

Write `.scratch/api-extraction/spec.md` (the final spec, superseding
sol-plan.md, incorporating agreed points and the admin seam) and tickets
`.scratch/api-extraction/issues/NN-<slug>.md` per `docs/agents/issue-tracker.md`
(What to build / Blocked by / Status / file ownership / acceptance criteria /
verification). Put your point-by-point answers to this review at the top of
`.scratch/api-extraction/review-sol-1.md`. Any `ESCALATE` items: list them
there with both positions in two lines each.
