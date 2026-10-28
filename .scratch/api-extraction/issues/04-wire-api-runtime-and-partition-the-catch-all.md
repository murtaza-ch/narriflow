# 04. Wire API runtime and partition the catch-all

**What to build:** The API starts as a separate Bun process with one composition owner, typed domain reservations and the 106 inline handlers physically partitioned before parallel work.

**Blocked by:** [03 - Build typed client transport and cache scope](03-build-typed-client-transport-and-cache-scope.md)

**Status:** done

**Suggested implementer:** Claude. The other pairing side reviews and returns findings to this owner.

Read [spec.md](../spec.md). It is the complete contract; the original brief/plan/reviews are not prerequisites. Claim this ticket before editing.

## Exact ownership

Paths are repo-relative. Every existing file below is exclusively assigned for this phase, including files that only need verification. A new `/**` directory includes its local tests/helpers, not adjacent directories. Read other files as evidence; do not edit them.

Existing files:

- `apps/web/app/api/[[...route]]/route.ts`
- `apps/web/lib/authenticated-request-inventory.test.ts`
- `apps/web/lib/authenticated-request-inventory.ts`
- `apps/worker/Dockerfile`
- `bun.lock`
- `package.json`
- `packages/services/src/index.ts`
- `packages/validators/package.json`
- `turbo.json`

- `packages/db/src/client.ts`

New files/directories or reserved skeletons handed off by a blocker:

- `apps/api/src/domains/session/routes.ts`
- `apps/api/src/domains/session/admission.ts`
- `apps/api/src/domains/session/runtime.ts`
- `apps/api/src/types/session.ts`
- `packages/api-client/src/session/index.ts`
- `packages/validators/src/api/session.ts`
- `apps/api/src/domains/workspace/routes.ts`
- `apps/api/src/domains/workspace/admission.ts`
- `apps/api/src/domains/workspace/runtime.ts`
- `apps/api/src/types/workspace.ts`
- `packages/api-client/src/workspace/index.ts`
- `packages/validators/src/api/workspace.ts`
- `apps/api/src/domains/billing/routes.ts`
- `apps/api/src/domains/billing/admission.ts`
- `apps/api/src/domains/billing/runtime.ts`
- `apps/api/src/types/billing.ts`
- `packages/api-client/src/billing/index.ts`
- `packages/validators/src/api/billing.ts`
- `apps/api/src/domains/projects/routes.ts`
- `apps/api/src/domains/projects/admission.ts`
- `apps/api/src/domains/projects/runtime.ts`
- `apps/api/src/types/projects.ts`
- `packages/api-client/src/projects/index.ts`
- `packages/validators/src/api/projects.ts`
- `apps/api/src/domains/library/routes.ts`
- `apps/api/src/domains/library/admission.ts`
- `apps/api/src/domains/library/runtime.ts`
- `apps/api/src/types/library.ts`
- `packages/api-client/src/library/index.ts`
- `packages/validators/src/api/library.ts`
- `apps/api/src/domains/clips/routes.ts`
- `apps/api/src/domains/clips/admission.ts`
- `apps/api/src/domains/clips/runtime.ts`
- `apps/api/src/types/clips.ts`
- `packages/api-client/src/clips/index.ts`
- `packages/validators/src/api/clips.ts`
- `apps/api/src/domains/studio/routes.ts`
- `apps/api/src/domains/studio/admission.ts`
- `apps/api/src/domains/studio/runtime.ts`
- `apps/api/src/types/studio.ts`
- `packages/api-client/src/studio/index.ts`
- `packages/validators/src/api/studio.ts`
- `apps/api/src/domains/ingest/routes.ts`
- `apps/api/src/domains/ingest/admission.ts`
- `apps/api/src/domains/ingest/runtime.ts`
- `apps/api/src/types/ingest.ts`
- `packages/api-client/src/ingest/index.ts`
- `packages/validators/src/api/ingest.ts`
- `apps/api/src/domains/recipes/routes.ts`
- `apps/api/src/domains/recipes/admission.ts`
- `apps/api/src/domains/recipes/runtime.ts`
- `apps/api/src/types/recipes.ts`
- `packages/api-client/src/recipes/index.ts`
- `packages/validators/src/api/recipes.ts`
- `apps/api/src/domains/publishing/routes.ts`
- `apps/api/src/domains/publishing/admission.ts`
- `apps/api/src/domains/publishing/runtime.ts`
- `apps/api/src/types/publishing.ts`
- `packages/api-client/src/publishing/index.ts`
- `packages/validators/src/api/publishing.ts`
- `apps/api/src/domains/brand/routes.ts`
- `apps/api/src/domains/brand/admission.ts`
- `apps/api/src/domains/brand/runtime.ts`
- `apps/api/src/types/brand.ts`
- `packages/api-client/src/brand/index.ts`
- `packages/validators/src/api/brand.ts`
- `apps/api/src/domains/automation/routes.ts`
- `apps/api/src/domains/automation/admission.ts`
- `apps/api/src/domains/automation/runtime.ts`
- `apps/api/src/types/automation.ts`
- `packages/api-client/src/automation/index.ts`
- `packages/validators/src/api/automation.ts`
- `apps/api/src/domains/rest/routes.ts`
- `apps/api/src/domains/rest/admission.ts`
- `apps/api/src/domains/rest/runtime.ts`
- `apps/api/src/types/rest.ts`
- `packages/api-client/src/rest/index.ts`
- `packages/validators/src/api/rest.ts`
- `apps/api/src/domains/integrations/routes.ts`
- `apps/api/src/domains/integrations/admission.ts`
- `apps/api/src/domains/integrations/runtime.ts`
- `apps/api/src/types/integrations.ts`
- `packages/api-client/src/integrations/index.ts`
- `packages/validators/src/api/integrations.ts`
- `apps/api/src/domains/developer/routes.ts`
- `apps/api/src/domains/developer/admission.ts`
- `apps/api/src/domains/developer/runtime.ts`
- `apps/api/src/types/developer.ts`
- `packages/api-client/src/developer/index.ts`
- `packages/validators/src/api/developer.ts`
- `apps/api/src/domains/reviews/routes.ts`
- `apps/api/src/domains/reviews/admission.ts`
- `apps/api/src/domains/reviews/runtime.ts`
- `apps/api/src/types/reviews.ts`
- `packages/api-client/src/reviews/index.ts`
- `packages/validators/src/api/reviews.ts`
- `apps/api/src/domains/progress/routes.ts`
- `apps/api/src/domains/progress/admission.ts`
- `apps/api/src/domains/progress/runtime.ts`
- `apps/api/src/types/progress.ts`
- `packages/api-client/src/progress/index.ts`
- `packages/validators/src/api/progress.ts`
- `apps/api/src/domains/exports/routes.ts`
- `apps/api/src/domains/exports/admission.ts`
- `apps/api/src/domains/exports/runtime.ts`
- `apps/api/src/types/exports.ts`
- `packages/api-client/src/exports/index.ts`
- `packages/validators/src/api/exports.ts`
- `packages/services/src/workspace-commands.ts`
- `packages/services/src/workspace-commands-runtime.ts`
- `packages/services/src/projects-commands.ts`
- `packages/services/src/projects-commands-runtime.ts`
- `packages/services/src/clips-commands.ts`
- `packages/services/src/clips-commands-runtime.ts`
- `packages/services/src/ingest-commands.ts`
- `packages/services/src/ingest-commands-runtime.ts`
- `packages/services/src/recipes-commands.ts`
- `packages/services/src/recipes-commands-runtime.ts`
- `packages/services/src/publishing-commands.ts`
- `packages/services/src/publishing-commands-runtime.ts`
- `packages/services/src/brand-commands.ts`
- `packages/services/src/brand-commands-runtime.ts`
- `packages/services/src/automation-commands.ts`
- `packages/services/src/automation-commands-runtime.ts`
- `packages/services/src/developer-commands.ts`
- `packages/services/src/developer-commands-runtime.ts`
- `packages/services/src/reviews-commands.ts`
- `packages/services/src/reviews-commands-runtime.ts`
- `packages/services/src/exports-commands.ts`
- `packages/services/src/exports-commands-runtime.ts`
- `apps/api/src/index.ts`
- `apps/api/src/app.ts`
- `apps/api/src/domains/platform/health.ts`
- `apps/api/scripts/check-route-inventory.ts`
- `apps/api/Dockerfile`
- `apps/api/railway.json`
- `apps/api/.env.example`

Create skeletal domain route/client/schema modules only here, then hand them to the backend owner through the 04 blocker. The 106 inline routes are mechanical partition work; do not implement all action/page endpoints. Preserve original sibling files for their named owner to relocate. Central export reservations use explicit subpaths; backend tickets must not edit barrels.

- `apps/api/package.json`
- `apps/api/tsconfig.json`
- `apps/api/tsconfig.build.json`
- `packages/api-client/package.json`
- `packages/api-client/src/index.ts`

- `packages/validators/src/clip-preview-peaks.ts`
- `packages/validators/src/review-selection.ts`

- `apps/api/scripts/native-smoke.ts`

## Endpoints, actions, pages and refresh sites

Rows retain their section/ordinal or exact source-line identifier from the independent inventory. Abbreviated table filenames are accompanied by the literal ownership manifest and exact source occurrences below. All action/page/fetch/refresh rows in owned files are in scope, including no-refresh callers and media navigation. Baseline observations do not override the spec's selected origins, route style, guest Bearer or new endpoints.

Mechanically partition all 106 inline registrations from the catch-all. Final route owner mapping:

| Inventory 3.2 row | Destination owner | Method/path |
| file:line | Call | Disposition |
| --- | --- | --- |
| --- | --- | --- |
| 1 | 17 | POST `/webhooks/tiktok/publication` |
| 2 | 04 | GET `/health` |
| 3 | 21 | GET `/autopilot/rules` |
| 4 | 21 | POST `/autopilot/rules` |
| 5 | 21 | PATCH `/autopilot/rules/:ruleId` |
| 6 | 21 | DELETE `/autopilot/rules/:ruleId` |
| 7 | 21 | POST `/autopilot/rules/:ruleId/take-over` |
| 8 | 21 | POST `/autopilot/rules/:ruleId/run-now` |
| 9 | 15 | GET `/recipes` |
| 10 | 15 | POST `/recipes` |
| 11 | 15 | PATCH `/recipes/:recipeId` |
| 12 | 15 | POST `/recipes/:recipeId/duplicate` |
| 13 | 15 | DELETE `/recipes/:recipeId` |
| 14 | 08 | GET `/projects` |
| 15 | 08 | GET `/workspace/search` |
| 16 | 08 | GET `/library/search` |
| 17 | 30 | GET `/workspace/exports/:exportId/download` |
| 18 | 05 | POST `/workspace/avatar/presign` |
| 19 | 05 | PATCH `/workspace/avatar` |
| 20 | 08 | POST `/projects/:id/generate` |
| 21 | 08 | GET `/projects/:id` |
| 22 | 08 | GET `/projects/:id/runs/:workflowRunId` |
| 23 | 08 | GET `/projects/:id/transcript` |
| 24 | 08 | GET `/projects/:id/transcript/utterances` |
| 25 | 08 | GET `/projects/:id/transcript/export` |
| 26 | 15 | POST `/ingest/link` |
| 27 | 15 | POST `/ingest/rss/preview` |
| 28 | 15 | POST `/ingest/rss/import` |
| 29 | 15 | GET `/ingest/:projectId` |
| 30 | 11 | GET `/projects/:id/clips` |
| 31 | 11 | GET `/projects/:id/clips/:clipId/preview-peaks` |
| 32 | 11 | POST `/projects/:id/clips/:clipId/title-suggestions` |
| 33 | 11 | POST `/projects/:id/clips/:clipId/duplicate` |
| 34 | 11 | POST `/projects/:id/clips/:clipId/create-from-selection` |
| 35 | 11 | POST `/projects/:id/clips/create-from-range` |
| 36 | 11 | DELETE `/projects/:id/clips/:clipId` |
| 37 | 11 | POST `/projects/:id/clips/render` |
| 38 | 30 | POST `/projects/:id/export-bundles` |
| 39 | 30 | POST `/projects/:id/export-bundles/preview` |
| 40 | 30 | GET `/projects/:id/export-bundles` |
| 41 | 11 | GET `/projects/:id/campaign-operations` |
| 42 | 17 | POST `/projects/:id/assisted-copy/generations` |
| 43 | 11 | POST `/projects/:id/thumbnail-frames` |
| 44 | 11 | GET `/projects/:id/thumbnail-frames/:operationId` |
| 45 | 11 | POST `/projects/:id/thumbnail-frames/:operationId/retry` |
| 46 | 11 | GET `/projects/:id/campaign-operations/editor-action-catalog` |
| 47 | 11 | POST `/projects/:id/campaign-operations/preview-editor-action` |
| 48 | 11 | POST `/projects/:id/campaign-operations/apply-brand-profile` |
| 49 | 11 | POST `/projects/:id/campaign-operations/apply-style` |
| 50 | 11 | POST `/projects/:id/campaign-operations/apply-motion` |
| 51 | 30 | GET `/projects/:id/export-bundles/:bundleId` |
| 52 | 30 | POST `/projects/:id/export-bundles/:bundleId/retry` |
| 53 | 30 | POST `/projects/:id/campaign-operations/:operationId/retry-export-bundle` |
| 54 | 30 | GET `/projects/:id/export-bundles/:bundleId/download` |
| 55 | 19 | POST `/projects/:id/brand-profiles/:profileId/scene-templates/:templateId/apply` |
| 56 | 27 | POST `/projects/:id/review-rounds` |
| 57 | 27 | GET `/projects/:id/review-rounds` |
| 58 | 27 | POST `/projects/:id/review-rounds/:roundId/invite` |
| 59 | 27 | POST `/projects/:id/review-rounds/:roundId/comments` |
| 60 | 27 | POST `/projects/:id/review-rounds/:roundId/comments/:commentId/resolve` |
| 61 | 27 | POST `/projects/:id/review-rounds/:roundId/comments/:commentId/reopen` |
| 62 | 27 | POST `/projects/:id/review-rounds/:roundId/notifications/retry` |
| 63 | 27 | POST `/projects/:id/review-rounds/:roundId/revoke` |
| 64 | 30 | POST `/projects/:id/clips/:clipId/exports` |
| 65 | 30 | GET `/projects/:id/exports/current` |
| 66 | 30 | GET `/projects/:id/clips/:clipId/exports/:exportId` |
| 67 | 30 | GET `/projects/:id/clips/:clipId/exports/:exportId/subtitles/:format` |
| 68 | 30 | GET `/projects/:id/clips/:clipId/timeline/:format` |
| 69 | 30 | GET `/projects/:id/clips/:clipId/timeline-source` |
| 70 | 30 | POST `/projects/:id/clips/:clipId/exports/:exportId/retry` |
| 71 | 30 | POST `/projects/:id/clips/:clipId/exports/:exportId/share-links` |
| 72 | 30 | DELETE `/projects/:id/clips/:clipId/exports/:exportId/share-links` |
| 73 | 11 | POST `/projects/:id/clips/apply-caption-preset` |
| 74 | 11 | POST `/projects/:id/clips/apply-studio-edits` |
| 75 | 08 | GET `/broll/search` |
| 76 | 08 | GET `/projects/:id/content-suite` |
| 77 | 08 | POST `/projects/:id/content-suite` |
| 78 | 08 | GET `/projects/:id/analytics` |
| 79 | 17 | GET `/social/accounts` |
| 80 | 17 | GET `/social/oauth/start/:platform` |
| 81 | 17 | GET `/social/oauth/callback` |
| 82 | 17 | GET `/social/oauth/facebook-selection/:token` |
| 83 | 17 | POST `/social/oauth/facebook-selection/:token` |
| 84 | 17 | DELETE `/social/accounts/:accountId` |
| 85 | 08 | GET `/projects/:id/dubs` |
| 86 | 08 | POST `/projects/:id/dubs` |
| 87 | 08 | GET `/projects/:id/dubs/:dubId/download` |
| 88 | 11 | GET `/projects/:id/clips/previews` |
| 89 | 11 | GET `/projects/:id/clips/:clipId/download` |
| 90 | 11 | GET `/projects/:id/clips/:clipId/file` |
| 91 | 19 | GET `/brand-templates` |
| 92 | 19 | GET `/brand-templates/:id` |
| 93 | 19 | POST `/brand-templates` |
| 94 | 19 | PATCH `/brand-templates/:id` |
| 95 | 19 | DELETE `/brand-templates/:id` |
| 96 | 19 | POST `/brand-templates/:id/set-default` |
| 97 | 19 | POST `/brand-templates/:id/duplicate` |
| 98 | 19 | POST `/brand-templates/logo/presign` |
| 99 | 19 | GET `/brand-templates/:id/logo-url` |
| 100 | 19 | GET `/audio-assets` |
| 101 | 19 | POST `/audio-assets/presign-upload` |
| 102 | 19 | POST `/audio-assets` |
| 103 | 19 | GET `/audio-assets/:id/playback-url` |
| 104 | 19 | PUT `/audio-assets/:id/favorite` |
| 105 | 19 | DELETE `/audio-assets/:id/favorite` |
| 106 | 19 | DELETE `/audio-assets/:id` |

### Inventory 3.2 row 2

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 2 | GET | `/health` | route.ts:236 |  |  | independent-trust: `public_health` |  |  | plain Hono | P0 |

### Inventory 5 exact file occurrences: apps/web/app/api/[[...route]]/route.ts

```text
644: * can play presigned media without CORS, but browser `fetch()` of JSON cannot;
```

## Acceptance criteria

- [x] All 106 inline registrations partition by the copied route rows with identical handlers/deps; existing siblings are handed to their domain owners, not reimplemented here.
- [x] All named route/client/type/schema and receipt-command exports/mounts reserved; domain owners need no central edit.
- [x] Bun entry health/ready, pool settings, SSE timeout hook, signal drain, Docker native packages and Railway health config follow spec.
- [x] Define apps/api scripts build/typecheck/test/test:inventory/openapi:generate/openapi:check and update the root authenticated-policy DB gate runner path. Use Docker repo root /app and API workdir /app/apps/api so the documented native smoke command runs. Root dev/build/env hashing and manifests/lock support API on 4000; worker remains 4001; use the three warm web typecheck timings captured by 01, before source extraction. Before 31 updates env-check for four files, record that legacy checker result separately; the final checker must pass before startup.
- [x] No Vercel forwarding/dual backend is deployed; baseline inventory comparison admits only declared routes and independent trust exceptions.
- [ ] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun run --cwd apps/api typecheck
bun test apps/api/src/http
bun run --cwd apps/api test:inventory
```

## Comments

Claimed and implemented by Claude (Sonnet 5.5), 2026-10-29. Paired review not run by the implementer (last acceptance box left open for the orchestrator).

### Contract for domain owners (05-30)
Every domain directory `apps/api/src/domains/<d>/` now has `admission.ts`, `routes.ts`, `runtime.ts`; `apps/api/src/types/<d>.ts` re-exports `type <D>Routes`; `packages/api-client/src/<d>/index.ts` exports `create<D>Client(transport)` (one `hc<<D>Routes>` via `createRpcClient`); `packages/validators/src/api/<d>.ts` exists (library holds `librarySearchRequestSchema`). No central file needs an edit when you add a route.
- **admission.ts**: `export const <d>Admission = {"GET /path": {kind, capability, ...} | {trust}} as const satisfies AdmissionTable` (keys `METHOD /path` relative to `/api`). `trust` entries: `provider_signature`, `oauth_state`, `public_health`, plus ticket 02's `signed_review_token|public_share_token|signed_opt_out_token`. `check-route-inventory` fails on a mounted route with no key, a key with no route, a gated key without `admit(...)`/`declareIndependentTrust(...)`, the same key registered twice, and a parameter route registered before a literal it would swallow. Gated entries need the marker; `public_health` and `provider_signature` (webhooks outside the chain) do not.
- **routes.ts**: `export function create<D>Routes(deps: <D>RouteDeps)` returns the chained `new Hono<ApiEnv>().get(path, admit(<d>Admission[key]), [uuidParams(...)], [requireIdempotencyKey()], [readCampaignRetryOf()], validate(...), handler)`; `export type <D>Routes = ReturnType<typeof create<D>Routes>`. Paths are relative; `app.ts` mounts them at `/api`. Services arrive through `deps` (destructure at the top of the factory so handlers read like the originals); replace the empty `Record<string, never>` deps type of a skeleton with the services you call. Fill `runtime.ts` (`create<D>RouteDeps(config: ApiConfig)`), which `src/runtime.ts` already calls. `uuidParams("id", ...)` (domains/platform/params.ts) is the post-admission UUID path guard.
- **Mount order** (`FIRST_PARTY_DOMAINS` in domains/index.ts): session, workspace, billing, projects, library, ingest, recipes, clips, exports, studio, brand, publishing, automation, reviews, developer, integrations, progress. Register literals before parameter routes inside your own factory; cross-domain overlaps are caught by the inventory check.
- **Body ceilings**: default 1 MiB for first-party routes (also webhooks). Put `bodyClass("editor")` (8 MiB, `src/body-limits.ts`) or `bodyClass("guest")` (32 KiB) as the FIRST handler of a route that needs another class; the app-level limiter reads the marker before any body is touched. Already marked: clips `apply-brand-profile|apply-style|apply-motion|apply-studio-edits`. 11/13 mark the editor PUT/reset and bulk writes; 27 marks guest access/opt-out.
- **Outside the first-party chain** (no session, no first-party CORS/JSON guard/envelope): webhooks are `create<Billing|Publishing|Automation>WebhookRoutes` in `domains/<d>/webhooks.ts` (billing = Stripe, 07; automation = Zoom event delivery incl. CRC, 21; publishing = TikTok, implemented), mounted at `/api` under a 1 MiB limit; Clerk's webhook is mounted by `app.ts` from ticket 01's adapter. REST: `domains/rest/routes.ts` `createRestRoutes` mounted at `/api/v1` (23). MCP: `domains/integrations/mcp.ts` `createMcpTransportRoutes` mounted at `/` (`/mcp`, `/.well-known/*`, `/mcp/integrations/*`, 24); first-party MCP continuation routes (`/api/integrations/mcp/*`) go in `integrations/routes.ts` behind `admit`. The inventory check skips `/api/v1`, `/mcp`, `/.well-known/` (their owners test them).
- **SSE** (29): call `disableIdleTimeout(c)` (src/server-hooks.ts) once the stream is admitted (Bun's idle timeout is 120 s, the heartbeat is 15 s, so this is only needed for streams that can be idle longer than 120 s; it is still the spec's rule); register a closer with `getLifecycle(c)?.onDrain(close)` so SIGTERM ends every subscriber (it returns an unregister function). `socketAddress(c)` gives the peer IP for per-IP limits.
- **Receipt command slots**: `packages/services/src/<d>-commands.ts` (`create<D>Commands(deps)`) and `<d>-commands-runtime.ts` (`<d>Commands`) exist for the 11 domains and are exported from the services index; `ReceiptCommand` names stay in ticket 02's `<d>-receipt-commands.ts`.
- **Tests**: `apps/api/src/test-app.ts` `createInventoryApp({policyRuntime?, domains?, health?})` composes the real app with inert edges (see `app.test.ts` for a fake policy runtime and injected domain deps). `src/admission-tables.test.ts` checks the spec's 50 preserved limits as their routes appear in the tables (35 present now; the rest are asserted automatically when the owning domain declares them).
- **Client**: `createRpcClient<Routes>(transport, mount = "/api")` in `packages/api-client/src/rpc.ts`; compile-time proof of read/mutation inference in `src/rpc-types.check.ts` (type-checked, not executed).
- `@narriflow/validators` now exports `./api/*`, `./clip-preview-peaks`, `./review-selection` (explicit subpaths; `src/index.ts` untouched).

### Partition result
106 inline registrations: 105 relocated (projects 13, library 3, ingest 4, recipes 5, automation 6, workspace 2, clips 22, exports 17, brand 17, publishing 8 incl. the TikTok webhook, reviews 8) + health (platform), plus new `GET /api/ready`. Inventory comparison reports 108 checked endpoints (105 + health + ready + Clerk webhook), 0 problems. The web catch-all `route.ts` is deleted; the eight sibling modules and their tests stay in `apps/web/app/api/[[...route]]/` for their owners (billing 07, stripe 07, zoom 21, upload-session 15, clip-generation 11, clip-editor 13, brand-profile 19, social-publication 17) and are no longer mounted anywhere.

### Deliberate behavior deltas (all spec-defined transport changes)
- Handlers use `admit` + `@hono/zod-validator` instead of the deleted web adapters; inline `safeParse` of body/query became `validate(...)`. Refusals share the common envelope (`invalid_input` with bounded issues). A missing/invalid `Idempotency-Key` is now 400 `idempotency_key_required` (was 400 `invalid_input`); `create-from-selection` invalid input now also returns `issues`.
- `GET /projects/:id/transcript/utterances` no longer sets `Cache-Control: private, max-age=120` (spec: no-store). `preview-peaks` keeps `private, max-age=3600, immutable` for 13 to decide.
- Social OAuth: `getOAuthOrigin` removed (origins are validated at startup). Provider redirect URI/`handleCallback` use `API_ORIGIN`; every browser redirect uses `WEB_ORIGIN`. Redirects and the GET start remain as they were (cookie-free POST + JSON conversion is ticket 17); `safeSocialRedirectPath` was copied into `publishing/redirect.ts` (delete web's copy with 06).
- `clip /file`, workspace export download and export-bundle download still redirect (Download Grant JSON conversion belongs to 11/30).
- Health body is `{ok, service: "narriflow-api", version}`; liveness no longer touches Clerk.
- Startup: `billingService.validateConfiguration({surface:"web"})` now runs in `createProductionApp` (the "web" surface name is the service's legacy label for webhook+portal requirements). `CLERK_WEBHOOK_SECRET` and `DATABASE_URL` are required there (config.ts is ticket 02's file, so validation lives in `src/runtime.ts` instead of `loadApiConfig`).
- DB pool: `packages/db/src/client.ts` passes `DATABASE_POOL_MAX|IDLE_TIMEOUT_MS|CONNECTION_TIMEOUT_MS` to the Neon pool only when set; `applyApiPoolDefaults` sets 10/30000/10000 for the API process. Worker and web keep driver defaults.
- Bun: `idleTimeout` 120 s (slowest synchronous LLM route is ~30-60 s), `maxRequestBodySize` 8 MiB, bound to `0.0.0.0:$PORT`. SIGTERM: readiness 503, registered subscribers close, `server.stop()`, Prisma `$disconnect`, exit 0 (hard exit 1 after 20 s). Redis is closed by process exit: the services layer exports no disconnect and those files are not mine.

### Spec issues / notes
- `@types/bun` cannot be loaded in this repo: it clashes with services' Node/DOM typings (`fetch.preconnect`, `ReadableStream`). `src/index.ts` declares the slice of `Bun.serve` it uses instead.
- The spec's per-domain `contracts.ts` is not in any ticket manifest, so it was not created; request schemas live in `packages/validators/src/api/<d>.ts`.
- `packages/api-client/tsconfig.json` (ticket 03 asked to delete its `paths`): validators subpaths now resolve through package `exports`, but the api-client type check walks `apps/api` and the services layer, so the block now mirrors `apps/api/tsconfig.json`'s backend mappings instead.
- Not verifiable here: Docker is unavailable, so `apps/api/Dockerfile` was not built (`bun install --frozen-lockfile` with the Dockerfile's manifest set, and `smoke:native` on the host, both pass); Railway ingress limits (URL 8 KiB / headers 32 KiB) and `X-Real-IP` overwrite; the deployed region/RTT.
- Web warm typecheck baseline is 4 s median (baseline.md); the web project does not compile during the sequence (34 transitional errors, below), so the after-measurement belongs to 31.

### Requests for other owners
- 23: `apps/api/scripts/generate-openapi.ts` (supports `--check`); `package.json` scripts `openapi:generate|openapi:check` already point at it and fail until it exists. `packages/api-client/package.json` already exports `./openapi` -> `src/openapi/index.ts`; create that file.
- 11/13: `isClipPreviewPeaks`/`ClipPreviewPeaks` now live in `@narriflow/validators/clip-preview-peaks`; make `packages/services/src/clip-preview-storage.ts` import them and delete its copy, and point the Studio `waveform-peaks.ts` at validators.
- 27: `encodeReviewSelection`/`decodeReviewSelection` now live in `@narriflow/validators/review-selection`; make `review.service.ts` import them (re-export from services if mcp-core needs it) and delete its copies; 28 points `lib/review-preselection.ts` at validators.
- 06/31: `scripts/env-check.ts` still checks web+worker+db only (legacy result recorded: passes). Remove `validateCoreEnv`/billing validation from the root layout (06), delete `apps/web/lib/env.ts`, `safe-redirect.ts` after their last callers move.
- 17: split provider callback origin from the web return origin inside the social services (routes already pass `callbackOrigin`/`webOrigin` separately); make OAuth start a POST returning `{authorizationUrl}`.
- 05: bootstrap/selection routes use `admit({kind: "signed_in"})` (`getSignedInActor`).
- 31: Dockerfile for the worker already copies `apps/api/package.json`; the API image installs the same manifest set. `apps/web/lib/authenticated-request-inventory.ts` keeps the 165-row baseline data (including `browserSessionHonoSurfaces`) because `integration-admission-parity.test.ts` still reads it; delete both when that parity test moves.

### Transitional breakage left for owners (web typecheck, 34 errors)
`lib/authenticated-request-action.ts`, `lib/authenticated-request-page.ts`, `lib/workflow-stream-reauthorization.ts` (31/29), `app/api/stream/[projectId]/route.ts` (29), `app/api/[[...route]]/{zoom-http,brand-profile-routes}.ts` (21/19), `lib/rest-api/app.ts` (23), `app/workspaces/new/actions.ts`, `app/invite/[token]/actions.ts` (05), `app/mcp/integrations/[workspaceId]/[...upload]/route.ts` (24), and nine `app/(app)` files (06-22). All import modules removed by tickets 01/02; none is new from this ticket.

### Evidence
- `bun run --cwd apps/api typecheck` clean; `bun run typecheck` clean in packages/api-client, validators, services, db, auth; `bunx turbo run build --filter=@narriflow/api` 8/8 tasks pass.
- `bun test apps/api/src` -> 229 pass, 6 skip (DB suite), 0 fail (includes http 131/6 skip, app composition, route inventory, admission tables, error codes, DB pool); `bun test packages/api-client` 111 pass; `bun test packages/validators` 615 pass; `cd apps/web && bun test lib/authenticated-request-inventory.test.ts` 15 pass.
- `bun run --cwd apps/api test:inventory` -> `route_inventory_checked routes=108 problems=0`.
- `.scratch/api-extraction/db-gate.sh bun run test:authenticated-request-policy:db` -> 4 pass, 0 skipped (root script now targets `apps/api/scripts/run-authenticated-request-policy-db-tests.ts`).
- `bun run --cwd apps/api smoke:native` -> font metadata, argon2id, sharp+ffprobe, ffmpeg thumbnail all ok on the host. `bun install --frozen-lockfile` consistent (lock diff: `apps/api` workspace deps, `@narriflow/api-client` deps).
- Local start: with env borrowed from `apps/web/.env.local` (no env file edited) `bun src/index.ts` listens on 4000; `/api/health` 200, `/api/ready` 200 (Neon reachable), `/api/projects` 401 envelope with CORS for `http://localhost:3000`, preflight 204 with the first-party header set; SIGTERM logs `api_draining` then `api_drained` and exits 0. `bun run dev` (turbo `--parallel`) includes the API through its `dev` script; it needs `apps/api/.env` (see `.env.example`).
- `bun run env:check` (legacy, web+worker+db files only) passes; four-file check is ticket 31's.
- `bunx biome check` on all owned paths: clean (one pre-existing info in `packages/validators/src/caption-preset.ts`).
