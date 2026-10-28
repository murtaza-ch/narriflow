# 23. Move REST v1 and detach docs from backend

**What to build:** REST v1 keeps its 31-operation public contract on API; docs use generated JSON and external clients use the correct API origin.

**Blocked by:** [04 - Wire API runtime and partition the catch-all](04-wire-api-runtime-and-partition-the-catch-all.md)

**Status:** ready-for-agent

**Suggested implementer:** Sol. The other pairing side reviews and returns findings to this owner.

Read [spec.md](../spec.md). It is the complete contract; the original brief/plan/reviews are not prerequisites. Claim this ticket before editing.

## Exact ownership

Paths are repo-relative. Every existing file below is exclusively assigned for this phase, including files that only need verification. A new `/**` directory includes its local tests/helpers, not adjacent directories. Read other files as evidence; do not edit them.

Existing files:

- `apps/web/app/(docs)/_components/api/api-state.tsx`
- `apps/web/app/(docs)/_components/api/body-state.ts`
- `apps/web/app/(docs)/_components/api/chip.tsx`
- `apps/web/app/(docs)/_components/api/choice-menu.tsx`
- `apps/web/app/(docs)/_components/api/code-card.tsx`
- `apps/web/app/(docs)/_components/api/code-theme.ts`
- `apps/web/app/(docs)/_components/api/endpoint-page.tsx`
- `apps/web/app/(docs)/_components/api/examples.ts`
- `apps/web/app/(docs)/_components/api/expandable.tsx`
- `apps/web/app/(docs)/_components/api/field-list.tsx`
- `apps/web/app/(docs)/_components/api/fields.tsx`
- `apps/web/app/(docs)/_components/api/highlight-code.ts`
- `apps/web/app/(docs)/_components/api/live-code.tsx`
- `apps/web/app/(docs)/_components/api/options.tsx`
- `apps/web/app/(docs)/_components/api/path-bar.tsx`
- `apps/web/app/(docs)/_components/api/persisted.ts`
- `apps/web/app/(docs)/_components/api/playground-fields.tsx`
- `apps/web/app/(docs)/_components/api/playground-host.tsx`
- `apps/web/app/(docs)/_components/api/playground-result.tsx`
- `apps/web/app/(docs)/_components/api/playground.tsx`
- `apps/web/app/(docs)/_components/api/request-panel.tsx`
- `apps/web/app/(docs)/_components/api/request-spec.ts`
- `apps/web/app/(docs)/_components/api/response-section.tsx`
- `apps/web/app/(docs)/_components/api/sample.test.ts`
- `apps/web/app/(docs)/_components/api/sample.ts`
- `apps/web/app/(docs)/_components/api/schema-fields.tsx`
- `apps/web/app/(docs)/_components/api/schema.ts`
- `apps/web/app/(docs)/_components/api/section.tsx`
- `apps/web/app/(docs)/_components/api/snippets.ts`
- `apps/web/app/(docs)/_components/api/variant-tabs.tsx`
- `apps/web/app/(docs)/_components/docs-header.tsx`
- `apps/web/app/(docs)/_components/docs-mobile-nav.tsx`
- `apps/web/app/(docs)/_components/docs-sidebar.tsx`
- `apps/web/app/(docs)/_components/mdx/accordion.tsx`
- `apps/web/app/(docs)/_components/mdx/badge.tsx`
- `apps/web/app/(docs)/_components/mdx/callout.tsx`
- `apps/web/app/(docs)/_components/mdx/card.tsx`
- `apps/web/app/(docs)/_components/mdx/code-frame.tsx`
- `apps/web/app/(docs)/_components/mdx/code.tsx`
- `apps/web/app/(docs)/_components/mdx/frame.tsx`
- `apps/web/app/(docs)/_components/mdx/heading.tsx`
- `apps/web/app/(docs)/_components/mdx/icon.tsx`
- `apps/web/app/(docs)/_components/mdx/index.tsx`
- `apps/web/app/(docs)/_components/mdx/link.tsx`
- `apps/web/app/(docs)/_components/mdx/panel.tsx`
- `apps/web/app/(docs)/_components/mdx/prose.tsx`
- `apps/web/app/(docs)/_components/mdx/steps.tsx`
- `apps/web/app/(docs)/_components/mdx/table.tsx`
- `apps/web/app/(docs)/_components/mdx/tabs-client.tsx`
- `apps/web/app/(docs)/_components/mdx/tabs.tsx`
- `apps/web/app/(docs)/_components/mdx/tile.tsx`
- `apps/web/app/(docs)/_components/mdx/tooltip.tsx`
- `apps/web/app/(docs)/_components/mdx/tree.tsx`
- `apps/web/app/(docs)/_components/mdx/update.tsx`
- `apps/web/app/(docs)/_components/mdx/utils.ts`
- `apps/web/app/(docs)/_components/mdx/zoom-image.tsx`
- `apps/web/app/(docs)/_components/method-badge.tsx`
- `apps/web/app/(docs)/_components/page/copy-page-menu.tsx`
- `apps/web/app/(docs)/_components/page/doc-page.tsx`
- `apps/web/app/(docs)/_components/page/page-header.tsx`
- `apps/web/app/(docs)/_components/page/pagination.tsx`
- `apps/web/app/(docs)/_components/page/toc.tsx`
- `apps/web/app/(docs)/_components/search/docs-search.tsx`
- `apps/web/app/(docs)/_components/search/search-dialog.tsx`
- `apps/web/app/(docs)/_components/search/search-result.tsx`
- `apps/web/app/(docs)/_components/search/search-store.ts`
- `apps/web/app/(docs)/docs-markdown/[[...slug]]/route.ts`
- `apps/web/app/(docs)/docs-og/[[...slug]]/route.tsx`
- `apps/web/app/(docs)/docs/[[...slug]]/page.tsx`
- `apps/web/app/(docs)/docs/layout.tsx`
- `apps/web/app/(docs)/docs/llms-full.txt/route.ts`
- `apps/web/app/(docs)/docs/llms.txt/route.ts`
- `apps/web/app/(docs)/docs/not-found.tsx`
- `apps/web/app/(docs)/docs/sitemap.ts`
- `apps/web/app/(marketing)/connector/page.tsx`
- `apps/web/app/api/docs/search/route.ts`
- `apps/web/app/api/v1/[[...route]]/route.ts`
- `apps/web/lib/docs/endpoint-markdown.ts`
- `apps/web/lib/docs/entries.ts`
- `apps/web/lib/docs/llms.ts`
- `apps/web/lib/docs/markdown.ts`
- `apps/web/lib/docs/mdx-to-markdown.ts`
- `apps/web/lib/docs/navigation.ts`
- `apps/web/lib/docs/openapi.ts`
- `apps/web/lib/docs/search-index.ts`
- `apps/web/lib/docs/site.ts`
- `apps/web/lib/docs/source.ts`
- `apps/web/lib/rest-api/__snapshots__/app.test.ts.snap`
- `apps/web/lib/rest-api/app.test.ts`
- `apps/web/lib/rest-api/app.ts`
- `apps/web/lib/rest-api/events.db.test.ts`
- `apps/web/lib/rest-api/public-openapi.test.ts`
- `apps/web/lib/rest-api/public-openapi.ts`
- `integrations/make/.gitignore`
- `integrations/make/README.md`
- `integrations/make/connections/narriflow/narriflow.common.json`
- `integrations/make/connections/narriflow/narriflow.communication.iml.json`
- `integrations/make/connections/narriflow/narriflow.params.iml.json`
- `integrations/make/general/base.iml.json`
- `integrations/make/general/common.json`
- `integrations/make/makecomapp.json`
- `integrations/make/modules/export-clip/export-clip.communication.iml.json`
- `integrations/make/modules/export-clip/export-clip.interface.iml.json`
- `integrations/make/modules/export-clip/export-clip.mappable-params.iml.json`
- `integrations/make/modules/export-clip/export-clip.samples.iml.json`
- `integrations/make/modules/export-clip/export-clip.static-params.iml.json`
- `integrations/make/modules/generate-clips/generate-clips.communication.iml.json`
- `integrations/make/modules/generate-clips/generate-clips.interface.iml.json`
- `integrations/make/modules/generate-clips/generate-clips.mappable-params.iml.json`
- `integrations/make/modules/generate-clips/generate-clips.samples.iml.json`
- `integrations/make/modules/generate-clips/generate-clips.static-params.iml.json`
- `integrations/make/modules/get-export-download/get-export-download.communication.iml.json`
- `integrations/make/modules/get-export-download/get-export-download.interface.iml.json`
- `integrations/make/modules/get-export-download/get-export-download.mappable-params.iml.json`
- `integrations/make/modules/get-export-download/get-export-download.samples.iml.json`
- `integrations/make/modules/get-export-download/get-export-download.static-params.iml.json`
- `integrations/make/modules/groups.json`
- `integrations/make/modules/make-an-api-call/make-an-api-call.communication.iml.json`
- `integrations/make/modules/make-an-api-call/make-an-api-call.interface.iml.json`
- `integrations/make/modules/make-an-api-call/make-an-api-call.mappable-params.iml.json`
- `integrations/make/modules/make-an-api-call/make-an-api-call.samples.iml.json`
- `integrations/make/modules/make-an-api-call/make-an-api-call.static-params.iml.json`
- `integrations/make/modules/propose-social-post/propose-social-post.communication.iml.json`
- `integrations/make/modules/propose-social-post/propose-social-post.interface.iml.json`
- `integrations/make/modules/propose-social-post/propose-social-post.mappable-params.iml.json`
- `integrations/make/modules/propose-social-post/propose-social-post.samples.iml.json`
- `integrations/make/modules/propose-social-post/propose-social-post.static-params.iml.json`
- `integrations/make/modules/submit-video-link/submit-video-link.communication.iml.json`
- `integrations/make/modules/submit-video-link/submit-video-link.interface.iml.json`
- `integrations/make/modules/submit-video-link/submit-video-link.mappable-params.iml.json`
- `integrations/make/modules/submit-video-link/submit-video-link.samples.iml.json`
- `integrations/make/modules/submit-video-link/submit-video-link.static-params.iml.json`
- `integrations/make/modules/watch-events/watch-events.communication.iml.json`
- `integrations/make/modules/watch-events/watch-events.epoch.iml.json`
- `integrations/make/modules/watch-events/watch-events.interface.iml.json`
- `integrations/make/modules/watch-events/watch-events.mappable-params.iml.json`
- `integrations/make/modules/watch-events/watch-events.samples.iml.json`
- `integrations/make/modules/watch-events/watch-events.static-params.iml.json`
- `integrations/make/rpcs/list-brand-profiles/list-brand-profiles.communication.iml.json`
- `integrations/make/rpcs/list-brand-profiles/list-brand-profiles.params.iml.json`
- `integrations/make/rpcs/list-social-accounts/list-social-accounts.communication.iml.json`
- `integrations/make/rpcs/list-social-accounts/list-social-accounts.params.iml.json`
- `integrations/make/test/validate.test.mjs`
- `integrations/zapier/.gitignore`
- `integrations/zapier/README.md`
- `integrations/zapier/package-lock.json`
- `integrations/zapier/package.json`
- `integrations/zapier/src/api.ts`
- `integrations/zapier/src/authentication.ts`
- `integrations/zapier/src/creates/export-clip.ts`
- `integrations/zapier/src/creates/generate-clips.ts`
- `integrations/zapier/src/creates/propose-social-post.ts`
- `integrations/zapier/src/creates/settings.ts`
- `integrations/zapier/src/creates/submit-video-link.ts`
- `integrations/zapier/src/events.ts`
- `integrations/zapier/src/hydrators.ts`
- `integrations/zapier/src/idempotency.ts`
- `integrations/zapier/src/index.ts`
- `integrations/zapier/src/searches/find-project.ts`
- `integrations/zapier/src/searches/get-export-download.ts`
- `integrations/zapier/src/triggers/autopilot-episode-imported.ts`
- `integrations/zapier/src/triggers/clips-ready.ts`
- `integrations/zapier/src/triggers/event-trigger.ts`
- `integrations/zapier/src/triggers/export-finished.ts`
- `integrations/zapier/src/triggers/finishing-ready.ts`
- `integrations/zapier/src/triggers/lists.ts`
- `integrations/zapier/src/triggers/posts.ts`
- `integrations/zapier/src/types.ts`
- `integrations/zapier/test/actions.test.ts`
- `integrations/zapier/test/app.test.ts`
- `integrations/zapier/test/authentication.test.ts`
- `integrations/zapier/test/errors.test.ts`
- `integrations/zapier/test/helpers.ts`
- `integrations/zapier/test/idempotency.test.ts`
- `integrations/zapier/test/searches.test.ts`
- `integrations/zapier/test/triggers.test.ts`
- `integrations/zapier/tsconfig.build.json`
- `integrations/zapier/tsconfig.json`

New files/directories or reserved skeletons handed off by a blocker:

- `apps/api/src/domains/rest/**`
- `apps/api/src/types/rest.ts`
- `packages/api-client/src/rest/**`
- `packages/validators/src/api/rest.ts`
- `apps/api/scripts/generate-openapi.ts`
- `packages/api-client/src/openapi/**`

Docs and marketing ownership is limited to the literal manifest and new OpenAPI artifacts. Keep unrelated docs content/design unchanged. REST is not first-party Clerk transport. Do not add a docs-index pipeline or API docs-search domain.

The chosen new endpoints for this ticket are the matching owner row in spec.md, "Endpoint and screen contracts added by extraction". All current endpoints/actions below retain their semantics unless that row explicitly changes transport. Fill only this domain's receipt-command module; current native receipts remain native.

## Endpoints, actions, pages and refresh sites

Rows retain their section/ordinal or exact source-line identifier from the independent inventory. Abbreviated table filenames are accompanied by the literal ownership manifest and exact source occurrences below. All action/page/fetch/refresh rows in owned files are in scope, including no-refresh callers and media navigation. Baseline observations do not override the spec's selected origins, route style, guest Bearer or new endpoints.

### Inventory 3.3 row 1

| # | Method | Path (under `/api/v1`) | app.ts line | Tag | Summary | Integration command (admission scope) | Handler calls | Idempotency-Key | Request validation |
|---|---|---|---|---|---|---|---|---|---|
| 1 | GET | `/workspace` | 282 | Workspace | Get the key's Workspace, plan, and credit usage | `get_workspace_usage` | `projectService.getUsageSummary` |  |  |

### Inventory 3.3 row 2

| # | Method | Path (under `/api/v1`) | app.ts line | Tag | Summary | Integration command (admission scope) | Handler calls | Idempotency-Key | Request validation |
|---|---|---|---|---|---|---|---|---|---|
| 2 | GET | `/brand-profiles` | 288 | Workspace | List Brand Profiles | `list_brand_profiles` | `brandProfileService.listSummaries` |  |  |

### Inventory 3.3 row 3

| # | Method | Path (under `/api/v1`) | app.ts line | Tag | Summary | Integration command (admission scope) | Handler calls | Idempotency-Key | Request validation |
|---|---|---|---|---|---|---|---|---|---|
| 3 | GET | `/recipes` | 294 | Workspace | List Recipes | `list_recipes` | `recipesView` |  |  |

### Inventory 3.3 row 4

| # | Method | Path (under `/api/v1`) | app.ts line | Tag | Summary | Integration command (admission scope) | Handler calls | Idempotency-Key | Request validation |
|---|---|---|---|---|---|---|---|---|---|
| 4 | GET | `/recipes/:id` | 299 | Workspace | Get a Recipe | `list_recipes` | `recipeView`, `recipeService.get` |  | params |

### Inventory 3.3 row 5

| # | Method | Path (under `/api/v1`) | app.ts line | Tag | Summary | Integration command (admission scope) | Handler calls | Idempotency-Key | Request validation |
|---|---|---|---|---|---|---|---|---|---|
| 5 | POST | `/uploads` | 304 | Uploads | Open an Upload Session | `open_upload` | `uploads.open` | required | json body |

### Inventory 3.3 row 6

| # | Method | Path (under `/api/v1`) | app.ts line | Tag | Summary | Integration command (admission scope) | Handler calls | Idempotency-Key | Request validation |
|---|---|---|---|---|---|---|---|---|---|
| 6 | GET | `/uploads/:id` | 325 | Uploads | Read an Upload Session | `open_upload` | `uploadSessionService.statusById` |  | params |

### Inventory 3.3 row 7

| # | Method | Path (under `/api/v1`) | app.ts line | Tag | Summary | Integration command (admission scope) | Handler calls | Idempotency-Key | Request validation |
|---|---|---|---|---|---|---|---|---|---|
| 7 | POST | `/uploads/:id/grants` | 330 | Uploads | Issue more multipart part URLs | `open_upload` | `uploads.grant` |  | params, json body |

### Inventory 3.3 row 8

| # | Method | Path (under `/api/v1`) | app.ts line | Tag | Summary | Integration command (admission scope) | Handler calls | Idempotency-Key | Request validation |
|---|---|---|---|---|---|---|---|---|---|
| 8 | POST | `/uploads/:id/finalize` | 336 | Uploads | Finalize an upload and start its intake | `open_upload` | `uploads.finalize` |  | params, json body |

### Inventory 3.3 row 9

| # | Method | Path (under `/api/v1`) | app.ts line | Tag | Summary | Integration command (admission scope) | Handler calls | Idempotency-Key | Request validation |
|---|---|---|---|---|---|---|---|---|---|
| 9 | DELETE | `/uploads/:id` | 346 | Uploads | Discard an unfinished upload | `open_upload` | `uploads.discard` |  | params |

### Inventory 3.3 row 10

| # | Method | Path (under `/api/v1`) | app.ts line | Tag | Summary | Integration command (admission scope) | Handler calls | Idempotency-Key | Request validation |
|---|---|---|---|---|---|---|---|---|---|
| 10 | POST | `/projects` | 352 | Projects | Submit a video link | `submit_video` | `submitVideo` | required | json body |

### Inventory 3.3 row 11

| # | Method | Path (under `/api/v1`) | app.ts line | Tag | Summary | Integration command (admission scope) | Handler calls | Idempotency-Key | Request validation |
|---|---|---|---|---|---|---|---|---|---|
| 11 | POST | `/captioned-videos` | 362 | Projects | Caption a finished video | `create_captioned_video` | `createCaptionedVideo`, `uploads.open` | required | json body |

### Inventory 3.3 row 12

| # | Method | Path (under `/api/v1`) | app.ts line | Tag | Summary | Integration command (admission scope) | Handler calls | Idempotency-Key | Request validation |
|---|---|---|---|---|---|---|---|---|---|
| 12 | GET | `/projects` | 385 | Projects | List projects | `list_projects` | `workspaceLibraryService.listProjects`, `projectView` |  | query |

### Inventory 3.3 row 13

| # | Method | Path (under `/api/v1`) | app.ts line | Tag | Summary | Integration command (admission scope) | Handler calls | Idempotency-Key | Request validation |
|---|---|---|---|---|---|---|---|---|---|
| 13 | GET | `/projects/:id` | 392 | Projects | Get a project | `get_project` | `projectService.getProjectSnapshot`, `projectView` |  | params |

### Inventory 3.3 row 14

| # | Method | Path (under `/api/v1`) | app.ts line | Tag | Summary | Integration command (admission scope) | Handler calls | Idempotency-Key | Request validation |
|---|---|---|---|---|---|---|---|---|---|
| 14 | GET | `/library/search` | 399 | Library | Search transcripts | `search_library` | `librarySearchService.search` |  | query |

### Inventory 3.3 row 15

| # | Method | Path (under `/api/v1`) | app.ts line | Tag | Summary | Integration command (admission scope) | Handler calls | Idempotency-Key | Request validation |
|---|---|---|---|---|---|---|---|---|---|
| 15 | POST | `/projects/:id/generations` | 406 | Projects | Generate clips | `generate_clips` | `generateClips` | required | params, json body |

### Inventory 3.3 row 16

| # | Method | Path (under `/api/v1`) | app.ts line | Tag | Summary | Integration command (admission scope) | Handler calls | Idempotency-Key | Request validation |
|---|---|---|---|---|---|---|---|---|---|
| 16 | GET | `/projects/:id/clips` | 417 | Clips | List a project's clips by virality | `list_clips` | `clipService.listClipReviewFacts`, `clipView` |  | query, params |

### Inventory 3.3 row 17

| # | Method | Path (under `/api/v1`) | app.ts line | Tag | Summary | Integration command (admission scope) | Handler calls | Idempotency-Key | Request validation |
|---|---|---|---|---|---|---|---|---|---|
| 17 | GET | `/clips/:id` | 423 | Clips | Get a clip | `get_clip` | `locateClip`, `clipView`, `clipService.getClipReviewFacts` |  | query, params |

### Inventory 3.3 row 18

| # | Method | Path (under `/api/v1`) | app.ts line | Tag | Summary | Integration command (admission scope) | Handler calls | Idempotency-Key | Request validation |
|---|---|---|---|---|---|---|---|---|---|
| 18 | GET | `/clips/:id/timeline` | 430 | Clips | Get an editor timeline | `get_clip_timeline` | `locateClip`, `clipTimelineService.export` |  | query, params |

### Inventory 3.3 row 19

| # | Method | Path (under `/api/v1`) | app.ts line | Tag | Summary | Integration command (admission scope) | Handler calls | Idempotency-Key | Request validation |
|---|---|---|---|---|---|---|---|---|---|
| 19 | POST | `/clips/:id/exports` | 437 | Exports | Export a clip revision | `create_clip_export` | `locateClip`, `createClipExport`, `exportView` | required | params, json body |

### Inventory 3.3 row 20

| # | Method | Path (under `/api/v1`) | app.ts line | Tag | Summary | Integration command (admission scope) | Handler calls | Idempotency-Key | Request validation |
|---|---|---|---|---|---|---|---|---|---|
| 20 | GET | `/exports/:id` | 448 | Exports | Get an export | `get_clip_export` | `locateExport`, `clipExportService.getOwned`, `exportView` |  | params |

### Inventory 3.3 row 21

| # | Method | Path (under `/api/v1`) | app.ts line | Tag | Summary | Integration command (admission scope) | Handler calls | Idempotency-Key | Request validation |
|---|---|---|---|---|---|---|---|---|---|
| 21 | GET | `/exports/:id/download` | 456 | Exports | Issue Download Grants and subtitles | `get_export_download` | `clipExportService.issueDownloadGrants` |  | query, params |

### Inventory 3.3 row 22

| # | Method | Path (under `/api/v1`) | app.ts line | Tag | Summary | Integration command (admission scope) | Handler calls | Idempotency-Key | Request validation |
|---|---|---|---|---|---|---|---|---|---|
| 22 | GET | `/operations/:id` | 462 | Operations | Get Operation Status | `get_operation` | `operationStatusService.read` |  | params |

### Inventory 3.3 row 23

| # | Method | Path (under `/api/v1`) | app.ts line | Tag | Summary | Integration command (admission scope) | Handler calls | Idempotency-Key | Request validation |
|---|---|---|---|---|---|---|---|---|---|
| 23 | GET | `/social-accounts` | 469 | Publishing | List connected social accounts | `list_social_accounts` | `socialAccountsView` |  |  |

### Inventory 3.3 row 24

| # | Method | Path (under `/api/v1`) | app.ts line | Tag | Summary | Integration command (admission scope) | Handler calls | Idempotency-Key | Request validation |
|---|---|---|---|---|---|---|---|---|---|
| 24 | POST | `/social-posts/proposals` | 474 | Publishing | Propose a social post | `propose_social_post` | `proposeSocialPost` | required | json body |

### Inventory 3.3 row 25

| # | Method | Path (under `/api/v1`) | app.ts line | Tag | Summary | Integration command (admission scope) | Handler calls | Idempotency-Key | Request validation |
|---|---|---|---|---|---|---|---|---|---|
| 25 | GET | `/events` | 484 | Events | List Workspace Events | `list_events` | `listEvents` |  | query |

### Inventory 3.3 row 26

| # | Method | Path (under `/api/v1`) | app.ts line | Tag | Summary | Integration command (admission scope) | Handler calls | Idempotency-Key | Request validation |
|---|---|---|---|---|---|---|---|---|---|
| 26 | GET | `/webhooks` | 491 | Webhooks | List webhooks | `list_webhooks` | `webhookSubscriptions.list` |  |  |

### Inventory 3.3 row 27

| # | Method | Path (under `/api/v1`) | app.ts line | Tag | Summary | Integration command (admission scope) | Handler calls | Idempotency-Key | Request validation |
|---|---|---|---|---|---|---|---|---|---|
| 27 | POST | `/webhooks` | 496 | Webhooks | Create a webhook | `manage_webhooks` | `webhookSubscriptions.create` |  |  |

### Inventory 3.3 row 28

| # | Method | Path (under `/api/v1`) | app.ts line | Tag | Summary | Integration command (admission scope) | Handler calls | Idempotency-Key | Request validation |
|---|---|---|---|---|---|---|---|---|---|
| 28 | DELETE | `/webhooks/:id` | 506 | Webhooks | Delete a webhook | `manage_webhooks` | `webhookSubscriptions.delete` |  | params |

### Inventory 3.3 row 29

| # | Method | Path (under `/api/v1`) | app.ts line | Tag | Summary | Integration command (admission scope) | Handler calls | Idempotency-Key | Request validation |
|---|---|---|---|---|---|---|---|---|---|
| 29 | POST | `/webhooks/:id/enable` | 512 | Webhooks | Re-enable a webhook | `manage_webhooks` | `webhookSubscriptions.enable` |  | params |

### Inventory 3.3 row 30

| # | Method | Path (under `/api/v1`) | app.ts line | Tag | Summary | Integration command (admission scope) | Handler calls | Idempotency-Key | Request validation |
|---|---|---|---|---|---|---|---|---|---|
| 30 | POST | `/webhooks/:id/test` | 519 | Webhooks | Send a test event | `manage_webhooks` | `webhookSubscriptions.test` |  | params |

### Inventory 3.3 row 31

| # | Method | Path (under `/api/v1`) | app.ts line | Tag | Summary | Integration command (admission scope) | Handler calls | Idempotency-Key | Request validation |
|---|---|---|---|---|---|---|---|---|---|
| 31 | POST | `/operations/:id/callback/redeliver` | 526 | Operations | Redeliver completion callbacks | `redeliver_callback` | `redeliverCallbacks` | required | params |

### Inventory 4 row 10

| # | File | Methods | What it does | Next-specific dependencies | Trust / auth | Verdict |
|---|---|---|---|---|---|---|
| 10 | `app/api/docs/search/route.ts` (6 lines) | GET | Docs search: `searchDocs(query)` over the fumadocs index; `Response.json`. | none (`@/lib/docs/search-index`) | Public | **Stay in web.** Docs/content only; called same-origin by the docs UI. |

### Inventory 4 row 11

| # | File | Methods | What it does | Next-specific dependencies | Trust / auth | Verdict |
|---|---|---|---|---|---|---|
| 11 | `app/(docs)/docs-markdown/[[...slug]]/route.ts` (20 lines) | GET | Markdown rendition of each docs page (target of the `.md` and `Accept: text/markdown` rewrites). | `dynamic = "force-static"`, `generateStaticParams` | Public | **Stay in web.** |

### Inventory 4 row 12

| # | File | Methods | What it does | Next-specific dependencies | Trust / auth | Verdict |
|---|---|---|---|---|---|---|
| 12 | `app/(docs)/docs-og/[[...slug]]/route.tsx` (104 lines) | GET | OG image per docs page. | `next/og` `ImageResponse`, `node:fs` font read, `force-static`, `dynamicParams = false`; imports `lib/docs/openapi` (which imports `createRestApi`) | Public | **Stay in web.** Depends on the REST OpenAPI document (see below). |

### Inventory 4 row 13

| # | File | Methods | What it does | Next-specific dependencies | Trust / auth | Verdict |
|---|---|---|---|---|---|---|
| 13 | `app/(docs)/docs/llms.txt/route.ts` (7 lines) | GET | `llms.txt` index. | `force-static` | Public | **Stay in web.** |

### Inventory 4 row 14

| # | File | Methods | What it does | Next-specific dependencies | Trust / auth | Verdict |
|---|---|---|---|---|---|---|
| 14 | `app/(docs)/docs/llms-full.txt/route.ts` (7 lines) | GET | `llms-full.txt`. | `force-static` | Public | **Stay in web.** |

### Inventory 5 exact file occurrences: apps/web/app/(docs)/_components/api/playground.tsx

```text
86: const response = await fetch(request.url, {
```

### Inventory 5 exact file occurrences: apps/web/app/(docs)/_components/api/snippets.ts

```text
164: `fetch(${jsString(request.url)}, options)`,
216: `const response = await fetch(${JSON.stringify(request.url)}, {`,
```

### Inventory 5 exact file occurrences: apps/web/app/(docs)/_components/page/copy-page-menu.tsx

```text
45: const response = await fetch(markdownPath);
```

### Inventory 5 exact file occurrences: apps/web/app/(docs)/_components/search/search-dialog.tsx

```text
32: const response = await fetch(`/api/docs/search?query=${encodeURIComponent(query)}`, { signal: controller.signal });
```

### Inventory 5 exact file occurrences: apps/web/lib/rest-api/events.db.test.ts

```text
64: const response = await handler.fetch(new Request("https://narriflow.test/mcp", { method: "POST", headers: {
```

## Acceptance criteria

- [ ] All 31 v1 command mappings/statuses/scopes/callbacks/receipts/header contracts and public document preserved under independent API-key trust.
- [ ] Operation status URLs point at API; human review/composer/queue links point at web; external Zapier/Make defaults/config/tests use API.
- [ ] Deterministic generated OpenAPI JSON is consumed by docs without loading runtime/services/provider secrets; regeneration check compares normalized servers.
- [ ] Docs search stays web/content-only with existing scoring/snippets/results; playground and connector page advertise/call API.
- [ ] Snapshots/tests move with REST and callback SSRF/DNS protection is retained.
- [ ] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun test apps/api/src/domains/rest
bun run --cwd apps/api openapi:check
bun run --cwd apps/web build
```

## Comments

Append claim, requested seam changes, paired review and evidence here.
