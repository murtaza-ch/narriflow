# 31. Clean dependencies and prepare coordinated deployment

**What to build:** All obsolete web backend paths/dependencies are removed, import/bundle/env guards pass, and deployment artifacts/provider changes are concrete and reviewable.

**Blocked by:** [06 - Convert app shell and Workspace UI](06-convert-app-shell-and-workspace-ui.md), [09 - Convert explorer home and library search](09-convert-explorer-home-and-library-search.md), [10 - Convert Project detail composition and panels](10-convert-project-detail-composition-and-panels.md), [12 - Convert clip and campaign UI](12-convert-clip-and-campaign-ui.md), [14 - Convert Studio transport without changing session ownership](14-convert-studio-transport-without-changing-session-ownership.md), [16 - Convert upload intake and recipe UI](16-convert-upload-intake-and-recipe-ui.md), [18 - Convert publishing calendar and performance UI](18-convert-publishing-calendar-and-performance-ui.md), [20 - Convert Brand Kit UI](20-convert-brand-kit-ui.md), [22 - Convert automation and grants UI](22-convert-automation-and-grants-ui.md), [23 - Move REST v1 and detach docs from backend](23-move-rest-v1-and-detach-docs-from-backend.md), [25 - Expose developer controls and convert integrations UI](25-expose-developer-controls-and-convert-integrations-ui.md), [26 - Convert MCP continuation and upload UI](26-convert-mcp-continuation-and-upload-ui.md), [28 - Convert review share and internal review UI](28-convert-review-share-and-internal-review-ui.md), [29 - Move progress stream and all three consumers](29-move-progress-stream-and-all-three-consumers.md), [30 - Move exports downloads and delivery pages](30-move-exports-downloads-and-delivery-pages.md)

**Status:** done

**Suggested implementer:** Claude. The other pairing side reviews and returns findings to this owner.

Read [spec.md](../spec.md). It is the complete contract; the original brief/plan/reviews are not prerequisites. Claim this ticket before editing.

## Exact ownership

Paths are repo-relative. Every existing file below is exclusively assigned for this phase, including files that only need verification. A new `/**` directory includes its local tests/helpers, not adjacent directories. Read other files as evidence; do not edit them.

Existing files:

- `apps/web/lib/integration-admission-parity.test.ts`
- `apps/web/lib/plan-upgrade-pages.test.ts`
- `apps/web/lib/plan-upgrade-pages.contract.fixture.ts`
- `.github/workflows/ci.yml`
- `AGENTS.md`
- `README.md`
- `apps/web/.env.example`
- `apps/web/app/(app)/projects/actions.ts`
- `apps/web/lib/authenticated-request-action.ts`
- `apps/web/lib/authenticated-request-browser.test.ts`
- `apps/web/lib/authenticated-request-browser.ts`
- `apps/web/lib/authenticated-request-page.ts`
- `apps/web/lib/env.ts`
- `apps/web/next-env.d.ts`
- `apps/web/next.config.ts`
- `apps/web/package.json`
- `apps/web/proxy.ts`
- `apps/web/tsconfig.json`
- `apps/worker/.env.example`
- `apps/worker/Dockerfile`
- `biome.json`
- `bun.lock`
- `docs/adr/0009-authenticated-request-policy.md`
- `docs/adr/README.md`
- `docs/runbooks/authentication.md`
- `docs/runbooks/clip-composition-plan-rollout.md`
- `docs/runbooks/clip-render-attempt-rollout.md`
- `docs/runbooks/cloud-file-pickers.md`
- `docs/runbooks/environments.md`
- `docs/runbooks/mcp-launch-acceptance.md`
- `docs/runbooks/project-retention-restore.md`
- `docs/runbooks/social-publication.md`
- `docs/runbooks/studio-editing-session.md`
- `docs/runbooks/upload-session-intake.md`
- `docs/runbooks/workspace-billing.md`
- `docs/runbooks/youtube-import.md`
- `docs/runbooks/zoom-autopilot.md`
- `package.json`
- `packages/db/.env.example`
- `packages/services/src/index.ts`
- `packages/validators/package.json`
- `scripts/env-check.test.ts`
- `scripts/env-check.ts`
- `turbo.json`

- `packages/db/src/client.ts`

New files/directories or reserved skeletons handed off by a blocker:

- `apps/api/src/config.ts`
- `apps/api/src/app.ts`
- `apps/api/src/index.ts`
- `apps/api/src/http/env.test.ts`
- `apps/api/package.json`
- `apps/api/Dockerfile`
- `apps/api/railway.json`
- `apps/api/.env.example`
- `packages/api-client/package.json`
- `packages/api-client/tsconfig.build.json`
- `packages/api-client/src/index.ts`
- `docs/adr/0017-standalone-api.md`
- `scripts/check-web-backend-imports.ts`
- `docs/runbooks/api-extraction-cutover.md`

This is the final serial owner of shared manifests/composition/config and of obsolete projects/actions.ts and action/page/browser helpers. Functional domain fixes return to owners; do not use residual cleanup as authority to rewrite all UI files.

## Endpoints, actions, pages and refresh sites

Rows retain their section/ordinal or exact source-line identifier from the independent inventory. Abbreviated table filenames are accompanied by the literal ownership manifest and exact source occurrences below. All action/page/fetch/refresh rows in owned files are in scope, including no-refresh callers and media navigation. Baseline observations do not override the spec's selected origins, route style, guest Bearer or new endpoints.

### Inventory 5.10 refresh/fetch row at inventory line 860

| Action file | Paths revalidated |
| --- | --- |
| `(app)/projects/actions.ts:62,100,113,152,176,182,217,238,244,267,319,400` | `/projects`, `/projects/:id`; `redirect("/projects/:id")` (:47) and `redirect("/projects")` (:401) |

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/actions.ts

```text
62: revalidatePath("/projects");
100: revalidatePath("/projects");
113: revalidatePath("/projects");
152: revalidatePath("/projects");
176: revalidatePath(`/projects/${projectId}`);
182: revalidatePath(`/projects/${projectId}`);
217: revalidatePath(`/projects/${parsedInput.projectId}`);
238: revalidatePath(`/projects/${projectId}`);
244: revalidatePath(`/projects/${projectId}`);
267: revalidatePath(`/projects/${projectId}`);
319: revalidatePath(`/projects/${projectId}`);
400: revalidatePath("/projects");
```

### Inventory 1.4 function `retryIngestFormAction(formData)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:280` | `retryIngestFormAction(formData)` | `projectId` | `getIngestJobLifecycle().retry({projectId, workspaceId, actorUserId})`; catches `IngestRetryLimitExceededError`, `IngestNotFailedError`, `IngestReselectRequiredError` | `executeProjectAction(projectId,"processing.consume")` | retry limit in service | `{ok:boolean, error?}` (expected failures returned, not thrown, to survive Next error redaction) | `revalidatePath("/projects/:id")` | `projects/[projectId]/render-clips-button.tsx:484` (`router.refresh`:486), `upload/_components/retry-import-band.tsx:54` (`router.refresh`:56) | `POST /api/ingest/:projectId/retry` (route.ts:620 already has `GET /ingest/:projectId`) | upload |

### Inventory 1.4 function `createFolderAction(name)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `app/(app)/projects/actions.ts:54` | `createFolderAction(name)` | `string` (validated in service) | `workspaceLibraryService.createFolder` | `executeWorkspaceAction("content.edit")` | none | `{ok:true, folder:{...,createdAt ISO}}` / `{ok:false, error, errorCode, requestId}` (double try/catch) | `revalidatePath("/projects")` | `app/(app)/projects/_components/projects-header-actions.tsx:32` (`router.refresh`:46) | `POST /api/library/folders` | projects |

### Inventory 1.4 function `deleteFolderAction(folderId)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:94` | `deleteFolderAction(folderId)` | `string` | `workspaceLibraryService.deleteFolder` | `executeWorkspaceAction("content.edit")` | none | `void` / failure | `revalidatePath("/projects")` | `projects/_components/folders-panel.tsx:67` (`router.refresh`:75) | `DELETE /api/library/folders/:folderId` | projects |

### Inventory 1.4 function `renameFolderAction(folderId, name)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:104` | `renameFolderAction(folderId, name)` | `string, string` | `workspaceLibraryService.renameFolder` | `executeWorkspaceAction("content.edit")` | none | `{ok:true}` / `{ok:false,...}` | `revalidatePath("/projects")` | `folders-panel.tsx:42` (`router.refresh`:52) | `PATCH /api/library/folders/:folderId` | projects |

### Inventory 1.4 function `moveProjectToFolderAction(projectId, folderId\|null)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:142` | `moveProjectToFolderAction(projectId, folderId\|null)` | `string, string\|null` | `workspaceLibraryService.moveProject` | `executeProjectAction(projectId,"content.edit")` | none | `void` / failure | `revalidatePath("/projects")` | `projects/_components/projects-explorer.tsx:100` (`router.refresh`:113), `folders-panel.tsx:86` (`router.refresh`:94) | `PUT /api/projects/:projectId/folder` `{folderId}` | projects |

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

### Inventory 1.4 function `renderClipsFormAction(formData)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:249` | `renderClipsFormAction(formData)` | `projectId`, `idempotencyKey`, `aspectRatios[]` | `clipService.triggerClipRendering(appUser, projectId, idempotencyKey, undefined, aspectRatios\|undefined, "1080p")` | `executeProjectAction(projectId,"processing.consume")` | none | `void` | `revalidatePath("/projects/:id")` | **none (dead)** | existing `POST /api/projects/:id/clips/render` (route.ts:752); delete the action | projects |

### Inventory 1.4 function `setNotifyPreferenceAction(projectId, notifyOnComplete)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:331` | `setNotifyPreferenceAction(projectId, notifyOnComplete)` | `string, boolean` | `projectService.setProjectNotifyPreference`; catches `ProjectNotFoundError` | `executeProjectAction(projectId,"content.edit")` | none | `{ok:boolean, error?}` | none (no revalidate) | `processing-panel.tsx:299` | `PUT /api/projects/:projectId/notify-preference` | projects |

### Inventory 1.4 function `deleteProjectFormAction(formData)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:365` | `deleteProjectFormAction(formData)` | `projectId` | `projectService.deleteProject`; maps `ProjectAccessDeniedError`, `ProjectHasActiveWorkflowError`, `ProjectHasActivePublicationError`, `ProjectDeletionIncompleteError`; `ProjectNotFoundError` = success | `executeProjectAction(projectId,"content.edit")` | none | `{ok:false, error}` on mapped failure; on success **`redirect("/projects")`** | `revalidatePath("/projects")`, `redirect("/projects")` | `projects/_components/delete-project-button.tsx:62` | `DELETE /api/projects/:projectId` (idempotent: 404 treated as success by client); client navigates to `/projects` | projects |

The cross-page upgrade fixture and existing integration-admission parity test are assigned here after the domain wave, so their rewrite can use the final client page/contracts. Preserve their behavioral assertions; do not delete them merely because the old server adapter disappeared.

## Acceptance criteria

- [x] Every remaining web action/backend handler/helper deleted; only docs content search/Markdown/OG/text handlers remain. No 501 or forwarding backend remains.
- [x] Biome/source/dependency graph guards ban services/db/auth/email/mcp-core/API runtime imports throughout web; DTO types are safe and static bundle sentinel scan passes.
- [x] Web secret/dependency removal and API/worker Docker manifests/native smoke/build/env hashing are complete; env:check compares all four local files without values. (Docker itself is not installed on this machine: the image build and in-container smoke are not run; the native smoke passes. See evidence.)
- [x] Reconcile final route ledger, 61-function/62-name dispositions, 39-page union, 75 executable refreshes, three EventSources and URL navigation sites; return functional failures to owners.
- [x] Measure TypeScript threshold and only add precompiled client declarations if triggered; capture native/pool/region/request-count evidence and concrete redacted deployment/provider plan.
- [x] No unowned files changed (the few small edits outside the manifest are listed below, each one a leftover of the extraction or a requested seam); paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun run lint
bun run typecheck
bun run test
bun run env:check
bun run --cwd apps/api openapi:check
bun run --cwd apps/api build
bun run --cwd apps/web build
bun scripts/check-web-backend-imports.ts
docker build -f apps/api/Dockerfile -t narriflow-api:extraction .
docker run --rm --entrypoint bun --workdir /app/apps/api narriflow-api:extraction scripts/native-smoke.ts
```

## Comments

Append claim, requested seam changes, paired review and evidence here.

### Ticket 31 (Claude, 2026-10-29)

#### Collected requests addressed to 31 / "04/31" / "31 or 04" (checklist, all closed)

- [x] 02: Bun-native workspace-entry DB check on `getAppUserForClerkIdentity` -> moved to `apps/api/src/http/workspace-entry.db.test.ts` (skips unless the policy gate enables it; its `mock.module` runs only then, because it is process-wide and broke 4 REST timeline tests in `bun test src/`), wired into `apps/api/scripts/run-authenticated-request-policy-db-tests.ts`. Gate: 11 pass.
- [x] 02/21/23/29/31 transitional breakage: `projects/actions.ts`, `lib/authenticated-request-{action,page,inventory(+test)}`, `lib/integration-admission-parity.test.ts`, `lib/env.ts`, `lib/safe-redirect(+test)`, `app/_components/authenticated-action-form.tsx` deleted; `app/api/stream`, `app/api/[[...route]]`, REST adapter and `workflow-stream-reauthorization` were already gone; empty `app/api/{v1,webhooks,review}` directories removed. `lib/authenticated-request-browser.ts` stays (20 client callers use its failure wording and `upgradePromptFromFailure`), as 06/14 asked.
- [x] 03: `@narriflow/api-client` dependency, `@tanstack/react-query(+devtools)`, tsconfig paths and `transpilePackages` are in place; web paths for auth/db/email/services removed.
- [x] 04/31 (05): api-client root exports. Declined on purpose: spec "Client import convention" says the root exports only core/rpc/client factories and domains import from `@narriflow/api-client/<domain>`; no `export *` of domains. 07 billing and 19 brand subpath exports are covered by `"./*"`.
- [x] 04/31 (05, 17): `route-inventory.test.ts` hard-coded 108 is already a lower bound (`> 108`); inventory is 281 routes, 44 protocol routes, 0 problems.
- [x] 04: `scripts/env-check.ts` compares four files (see below); `validateCoreEnv`/`validateWebhookEnv` (`lib/env.ts`) deleted; Dockerfiles already install the full manifest set.
- [x] 06: `NEXT_PUBLIC_API_URL` at build time (next.config throws without it in production; documented; CI sets it); Turbo hashing already lists it for `build` and `dev`.
- [x] 06/07/09/16/20: `useWorkspaceBootstrap` is now a thin hook over 05's `workspaceBootstrapQuery`; the local factory in `usage.ts` is deleted (one cache key, same entry as the shell).
- [x] 06: `workspace-entry.db.fixture.ts` wired (above); `members-panel.test.tsx` mock gains `useWorkspaceScope`; `upgrade.browser.fixture.tsx` now spreads the real `next/navigation` and runs `ReviewPanel`/`ProjectShareButton` under the real `ApiProvider` with controlled Clerk and fetch. The rewritten fixture found a real defect, fixed in `review-panel.tsx` and `project-share-button.tsx`: `upgradePromptFromFailure({..., ...reason.details})` spread the details instead of passing `details`, so no plan refusal in the review composer or share dialog ever opened the upgrade dialog.
- [x] 06/26: `AppShell` gate for MCP continuations: already resolved by 26's `(continuation)` route group (SessionApiProvider > RequireSignIn > SessionGate, no Workspace gate); `/integrations(.*)` is also page-protected in `proxy.ts`.
- [x] 07: `billing-browser`/`billing-plan-change` still have callers (`billing-plans.tsx`), kept; `billingService.validateConfiguration({surface:"web"})` stays at API startup.
- [x] 08/10: `retry/regenerate/render/queueTranscription/applyBrand/notify` actions gone with `projects/actions.ts`; `MAX_INGEST_RETRY_ATTEMPTS`, `isQuotaBlockedMidFlight` -> `@narriflow/validators` (`ingest.ts`, tests moved), `brandPlanRequirement` (+`BrandPlanRequirement`) -> `@narriflow/validators` `pricing.ts`; services import them from there, the API's brand/studio modules too; web mirrors in `project-state.ts` and `brandApplyRequirement` deleted/delegated.
- [x] 10: `transcript/export` query validator: `transcriptExportQuerySchema` in `@narriflow/validators/api/projects` (+ test), used by `validate("query", ...)` in the route; the web client's `as { param }` cast is gone, so `format` is typed. Invalid formats now return the common validation envelope instead of the bespoke `invalid_transcript_export_format`.
- [x] 11/12: `/clips/:clipId/file` row and `retryIngestFormAction` gone with the inventory/actions.
- [x] 14: `upgradePromptFromFailure`/`BrowserRequestFailure` kept in `authenticated-request-browser.ts`.
- [x] 18: `what-worked.test.tsx` no longer imports services: captured real summary/guidance shapes in `what-worked.fixtures.ts` (the computation stays covered in packages/services). No Biome exemption needed.
- [x] 19: `brand-receipts.db.test.ts` was already in the brand runner (52 pass); `brand-commands.ts`/`brand-commands-runtime.ts` and their index exports deleted (`BRAND_RECEIPT_COMMANDS` stays: `ReceiptCommand` composes it).
- [x] 20: Studio/Brand audio upload deduplicated into `apps/web/lib/audio-upload.ts` (`uploadAudioFile(file, kind, mutations)`); Studio `audio-upload.ts` deleted, Brand's `useAudioUpload` delegates; the Brand copy now also omits credentials on the R2 PUT. `plan-upgrade-pages.contract.fixture.ts` deleted; `lib/plan-upgrade-pages.test.ts` rewritten as a direct test of the same promises (style count -> tier, credits settlement period, unknown duration, reserved/released vs settled/refunded) at the API-requirement / `deriveProjectView` seam, no subprocess.
- [x] 21: `admission-tables.test.ts` Zoom key renamed to `POST /zoom/oauth/start`; the test no longer filters rows silently (a renamed key now fails).
- [x] 23: `run-integration-api-db-tests.ts` suite path -> `apps/api/src/domains/rest/events.db.test.ts`; parity test moved to `apps/api/src/integration-admission-parity.test.ts` (REST routes via `createRestRoutes`, first-party peers from the admission tables; page peers became `GET /projects/:id`, `/workspace/usage`, `/social/accounts`); root `test:mcp:integration` updated to the API paths; CI runs `openapi:check`. M4 docs hard-codes replaced (below). Integration defaults stay fail-loud placeholders until the hostname exists (ticket 32).
- [x] 24: Clerk client injection: `createExternalRoutes(config, clerkClient)` passes the process client into `createMcpTransportDeps` (`apps/api/src/runtime.ts`, 3 lines); `apps/mcp/.env.example` gains `NARRIFLOW_URL` (A) and `WEB_ORIGIN` (W); MCP setup docs and runbook updated; E2E script root command now runs from `apps/api`.
- [x] 24/27 and review-claude-sol: `TRUSTED_CLIENT_IP_HEADER=x-real-ip` and its verification are in `deploy-env.md` and the cutover runbook. Unknown `/api/v1/*` fallthrough (finding 6) was fixed by 23.
- [x] 25/22/29: stale inventory rows gone with the file; `/api/stream(.*)` and every API/MCP/discovery matcher removed from `proxy.ts` (now page protection only; also protects `/recipes`, `/search`, `/integrations`, `/help`, `/whats-new`, which used to rely on server-page redirects).
- [x] 28/27 (+ review-claude-26-28): CSP `connect-src` has the exact `new URL(NEXT_PUBLIC_API_URL).origin` in the general report-only policy and the review policy (the 28 request); `upstash.io` dropped (server-side only).
- [x] 30: `exports-commands.ts`/`-runtime.ts` skeletons deleted (`exports-receipt-commands.ts` stays: `create_clip_export` is registered there).
- [x] wave-b review: `clips-commands.db.test.ts` added to the clip-editor-persistence runner (28+7+3 pass).
- [x] 02 spec/foundation: `serverExternalPackages`, `outputFileTracingIncludes` (sharp/ffprobe) removed from `next.config.ts`; `transpilePackages` reduced to api-client/ui/validators; web dependencies pruned (below).

#### What changed (summary)

- Web manifest: removed `@ffprobe-installer/ffprobe`, `@hono/zod-openapi`, `@modelcontextprotocol/server`, `@narriflow/{auth,db,email,mcp-core,services}`, `@node-rs/argon2`, `@prisma/client`, `ioredis`, `next-safe-action`, `sharp`, `svix`, dev `@prisma/adapter-pg`, `@seriousme/openapi-schema-validator`, `@types/pg`, `pg`. Root `stripe` removed (services declares it). `bun.lock` regenerated (21 lines out); `bun install --frozen-lockfile --dry-run` passes.
- Guards: Biome `noRestrictedImports` override for `apps/web/**` (services/db/auth/mcp-core/email/api, subpaths, type imports included); `scripts/check-web-backend-imports.ts` (+ test, run by `bun run test`, script `check:web-split`): imports (static, dynamic, `require`, `mock.module`), relative paths into backend source, `"use server"`, route handlers outside four docs-content ones, backend dependencies in the manifest, and with a build `.next/static` scan for backend module names and every API/worker variable name (whole-token match; Clerk's own `CLERK_SECRET_KEY`/`CLERK_PUBLISHABLE_KEY` and `NODE_ENV` allowed). CI runs it after the production build with `--bundle`.
- `env-check`: reads `apps/api/.env`, `apps/web/.env.local`, `apps/worker/.env`, `packages/db/.env`; database identities, R2, Redis, image-generation and shared secrets, Clerk instance, origin agreement (`NEXT_PUBLIC_API_URL`=`API_ORIGIN`, `NEXT_PUBLIC_APP_URL`=`WEB_ORIGIN`, CORS/authorized parties include the web origin, `WORKER_APP_BASE_URL` is the web origin); messages never contain values; backend names left in the web file are warned by name. 11 tests.
- Examples: `apps/api/.env.example` (already complete; verified against the code's env reads), `apps/web/.env.example` reduced to `NEXT_PUBLIC_*` + Clerk (removed 40+ backend/observability names including `UPSTASH_REDIS_TOKEN` and `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, which no code reads), worker example comments now say API instead of web and that `WORKER_APP_BASE_URL` is W, mcp example gains A/W.
- Docs: README, AGENTS.md, GLOSSARY.md (two terms), ADR 0017 (new), ADR 0009 amendment, ADR index, `environments.md`, `mcp-launch-acceptance`, `authentication`, `cloud-file-pickers`, `zoom-autopilot`, `social-publication`, `workspace-billing`, `upload-session-intake`, `clip-render-attempt-rollout`, `project-retention-restore`, `youtube-import`, new `api-extraction-cutover.md`. Docs pages and the n8n templates (both copies) use `https://api.narriflow.example` as the API-origin placeholder, replaced by `NEXT_PUBLIC_API_URL` by a remark plugin in `source.config.ts` and, for the Markdown/llms text, `withDocsApiOrigin` (`lib/docs/api-origin.ts`; a test also forbids `app.narriflow.com` API/MCP addresses in content). `.scratch/api-extraction/deploy-env.md` has the names-only Railway/Vercel/worker/provider plan.

#### Evidence

- `bun run lint`: 0 errors (11 pre-existing CSS warnings). `bun run typecheck`: 15 packages, exit 0. `bun run test`: exit 0 (validators 620, services 1386, mcp-core 154, api 826 + 32 DB skips, api-client 228, web 924, worker 722, ui 10, caption-fonts 22, composition-plan 79, root scripts 21).
- `bun run --cwd apps/api test:inventory`: 281 routes, 44 protocol routes, 0 problems. `openapi:check`: matches all 31 operations. `apps/api build`, `api-client build`: ok. `bun run --cwd apps/api smoke:native`: font metadata, argon2, sharp+ffprobe, ffmpeg thumbnail all ok natively. `bun install --frozen-lockfile --dry-run`: ok.
- `bun run --cwd apps/web build` with `NEXT_PUBLIC_API_URL=http://localhost:4000` and the other public vars exported from `.env.local` in the shell only: exit 0 (twice, second after the Markdown fix). `bun scripts/check-web-backend-imports.ts --bundle`: pass (the first bundle scan correctly flagged name substrings, which led to the whole-token rule).
- DB gates via `db-gate.sh` (local Postgres only): workflow 175, upload-session 15, processing-usage 31, workspace-billing 16, social-publication 125, clip-editor-persistence 28+7+3, authenticated-request-policy 11 (4 policy + 7 workspace-entry), brand-profiles 52, integration-api all ten suites incl. the relocated REST events suite, library-search 23, vizard-expansion 71. All exit 0.
- Typecheck threshold: warm `tsc -p apps/web` runs 5.0 / 3.9 / 4.0 s (median 4.0 s) against the 4 s baseline (ratio 1.0, threshold 1.5): no `hcWithType` precompilation added.
- `bun run env:check` fails only on the missing `apps/api/.env` (not mine to create): expected until the orchestrator writes the four env files.

#### Fixed outside the manifest (all leftovers of the extraction)

- `vizard-expansion.db.test.ts` (ticket 27 left it red): guest comments and decisions are receipt-backed (key required, `{ value, replayed }` result, fail-closed limiter), so the test goes through a `ReviewService` with an injected available limiter, per-call keys and `.value`; the "audit payload carries no guest content" assertion now checks everything except `metadata.receipt` (the spec-mandated replay snapshot) for guest name/comment text and the whole payload for tokens, secrets, addresses and links.
- `review-panel.tsx` / `project-share-button.tsx`: the `details` spread defect above. `uploads-tab.tsx`: null-guard for the shared uploader. `packages/services` / `apps/api` brand modules: import `brandPlanRequirement` from validators. `apps/web/repository-verification.test.ts`: workspace list includes `apps/api` and `packages/api-client`.

#### Open items for the orchestrator / ticket 32 (not done here)

- Docker is not installed on this machine: `docker build -f apps/api/Dockerfile` and the in-container `native-smoke` were not run (native smoke passes). Run them where Docker exists.
- Real `.env*` files and Vercel/Railway/provider changes (the orchestrator's): `deploy-env.md` has the names. `bun run env:check` needs `apps/api/.env`; the local web file still holds backend names (it warns).
- `bun audit --production` reports 10 advisories (2 critical, 8 high) on `next` 16.3.6 (fixed 16.4.1+) and `@modelcontextprotocol/*` 2.0.0 (fixed 2.3.0). They are pre-existing dependency versions, not introduced here, and `audit:production` is a CI step: bump deliberately (the API now hosts the MCP server).
- Hosted Zapier/Make defaults and public hostname (review-claude-sol finding 3), live W->A browser pass (CSP headers in production, review/share/opt-out, MCP continuation, SSE beyond 60 s, real `x-real-ip` behavior), Clerk `azp` of a real token, provider re-registration: ticket 32.
- Spec drift to note: `UPSTASH_REDIS_TOKEN` has no consumer (removed from the web example; still in the worker example, harmless).
