# 04. Wire API runtime and partition the catch-all

**What to build:** The API starts as a separate Bun process with one composition owner, typed domain reservations and the 106 inline handlers physically partitioned before parallel work.

**Blocked by:** [03 - Build typed client transport and cache scope](03-build-typed-client-transport-and-cache-scope.md)

**Status:** ready-for-agent

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

- [ ] All 106 inline registrations partition by the copied route rows with identical handlers/deps; existing siblings are handed to their domain owners, not reimplemented here.
- [ ] All named route/client/type/schema and receipt-command exports/mounts reserved; domain owners need no central edit.
- [ ] Bun entry health/ready, pool settings, SSE timeout hook, signal drain, Docker native packages and Railway health config follow spec.
- [ ] Define apps/api scripts build/typecheck/test/test:inventory/openapi:generate/openapi:check and update the root authenticated-policy DB gate runner path. Use Docker repo root /app and API workdir /app/apps/api so the documented native smoke command runs. Root dev/build/env hashing and manifests/lock support API on 4000; worker remains 4001; use the three warm web typecheck timings captured by 01, before source extraction. Before 31 updates env-check for four files, record that legacy checker result separately; the final checker must pass before startup.
- [ ] No Vercel forwarding/dual backend is deployed; baseline inventory comparison admits only declared routes and independent trust exceptions.
- [ ] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun run --cwd apps/api typecheck
bun test apps/api/src/http
bun run --cwd apps/api test:inventory
```

## Comments

Append claim, requested seam changes, paired review and evidence here.
