# 19. Move Brand Kit and media controls

**What to build:** Brand profile/style/font/scene/audio/visual/generated-media adapters preserve revision/default/membership/retained-reference semantics and retryable create receipts.

**Blocked by:** [04 - Wire API runtime and partition the catch-all](04-wire-api-runtime-and-partition-the-catch-all.md)

**Status:** done

**Suggested implementer:** Claude. The other pairing side reviews and returns findings to this owner.

Read [spec.md](../spec.md). It is the complete contract; the original brief/plan/reviews are not prerequisites. Claim this ticket before editing.

## Exact ownership

Paths are repo-relative. Every existing file below is exclusively assigned for this phase, including files that only need verification. A new `/**` directory includes its local tests/helpers, not adjacent directories. Read other files as evidence; do not edit them.

Existing files:

- `apps/web/app/api/[[...route]]/brand-profile-routes.ts`
- `packages/services/src/audio-asset.service.ts`
- `packages/services/src/brand-font.service.ts`
- `packages/services/src/brand-profile.service.ts`
- `packages/services/src/brand-template.service.ts`
- `packages/services/src/generated-media-runtime.ts`
- `packages/services/src/generated-media.test.ts`
- `packages/services/src/generated-media.ts`
- `packages/services/src/scene-template.service.ts`
- `packages/services/src/visual-asset.service.ts`

New files/directories or reserved skeletons handed off by a blocker:

- `apps/api/src/domains/brand/**`
- `apps/api/src/types/brand.ts`
- `packages/api-client/src/brand/**`
- `packages/validators/src/api/brand.ts`
- `packages/services/src/brand-receipt-commands.ts`
- `packages/services/src/brand-commands.ts`
- `packages/services/src/brand-commands-runtime.ts`

The chosen new endpoints for this ticket are the matching owner row in spec.md, "Endpoint and screen contracts added by extraction". All current endpoints/actions below retain their semantics unless that row explicitly changes transport. Fill only this domain's receipt-command module; current native receipts remain native.

## Endpoints, actions, pages and refresh sites

Rows retain their section/ordinal or exact source-line identifier from the independent inventory. Abbreviated table filenames are accompanied by the literal ownership manifest and exact source occurrences below. All action/page/fetch/refresh rows in owned files are in scope, including no-refresh callers and media navigation. Baseline observations do not override the spec's selected origins, route style, guest Bearer or new endpoints.

### Inventory 1.7 function `createBrandTemplateAction(input)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:17` | `createBrandTemplateAction(input)` | `brandTemplateInputSchema` (`BrandTemplateInput`) | `brandTemplateService.create` | `executeWorkspaceActionWithInput("brand.manage")` | in service | created template / failure | `revalidatePath("/brand-kit","layout")` | `brand-kit/_components/template-form.tsx:270` (then `router.push("/brand-kit/styles/:id")`:284) | existing `POST /api/brand-templates` (route.ts:1758) | brand-kit |

### Inventory 1.7 function `updateBrandTemplateAction(id, input)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:25` | `updateBrandTemplateAction(id, input)` | `brandTemplateUpdateSchema` (`BrandTemplateUpdate`) | `brandTemplateService.update` | `executeWorkspaceActionWithInput("brand.manage")` | in service | updated template / failure | same | `template-form.tsx:286` (`router.refresh`:300) | existing `PATCH /api/brand-templates/:id` (:1769) | brand-kit |

### Inventory 1.7 function `deleteBrandTemplateAction(id)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:36` | `deleteBrandTemplateAction(id)` | `string` | `brandTemplateService.softDelete` | `executeWorkspaceAction("brand.manage")` | none | `void` / failure | same | `brand-kit/_components/template-gallery.tsx:246` | existing `DELETE /api/brand-templates/:id` (:1780) | brand-kit |

### Inventory 1.7 function `setDefaultBrandTemplateAction(id)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:43` | `setDefaultBrandTemplateAction(id)` | `string` | `brandTemplateService.setDefault` | `executeWorkspaceAction("workspace.manage")` (note: `workspace.manage`, not `brand.manage`) | none | `void` / failure | same | `template-gallery.tsx:177` | existing `POST /api/brand-templates/:id/set-default` (:1786) | brand-kit |

### Inventory 1.7 function `duplicateBrandTemplateAction(id, newName?)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:50` | `duplicateBrandTemplateAction(id, newName?)` | `string, string?` | `brandTemplateService.duplicate` | `executeWorkspaceAction("brand.manage")` | none | never returns on success: **`redirect("/brand-kit/styles/:newId")`** | `revalidatePath`, `redirect` | `template-gallery.tsx:211` | existing `POST /api/brand-templates/:id/duplicate` (:1792) returning the new id; client navigates | brand-kit |

### Inventory 3.2 row 55

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 55 | POST | `/projects/:id/brand-profiles/:profileId/scene-templates/:templateId/apply` | route.ts:1067 | `campaignOperationService.applySceneTemplate` | `type ApplySceneTemplateInput` | browser-session: `content.edit`, project(id); campaignMutationInput(applySceneTemplateSchema, [ "id", "profileId", "templateId", ]); idempotency-key header | actor `apply-scene-template` 20/3600s | idempotency-key header | plain Hono | D6 |

### Inventory 3.2 row 91

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 91 | GET | `/brand-templates` | route.ts:1746 | `brandTemplateService.list` |  | browser-session: `content.view`, workspace |  |  | plain Hono | D6 |

### Inventory 3.2 row 92

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 92 | GET | `/brand-templates/:id` | route.ts:1752 | `brandTemplateService.get` |  | browser-session: `content.view`, workspace |  |  | plain Hono | D6 |

### Inventory 3.2 row 93

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 93 | POST | `/brand-templates` | route.ts:1758 | `brandTemplateService.create` | `brandTemplateInputSchema` | browser-session: `brand.manage`, workspace |  |  | plain Hono | D6 |

### Inventory 3.2 row 94

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 94 | PATCH | `/brand-templates/:id` | route.ts:1769 | `brandTemplateService.update` | `brandTemplateUpdateSchema` | browser-session: `brand.manage`, workspace |  |  | plain Hono | D6 |

### Inventory 3.2 row 95

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 95 | DELETE | `/brand-templates/:id` | route.ts:1780 | `brandTemplateService.softDelete` |  | browser-session: `brand.manage`, workspace |  |  | plain Hono | D6 |

### Inventory 3.2 row 96

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 96 | POST | `/brand-templates/:id/set-default` | route.ts:1786 | `brandTemplateService.setDefault` |  | browser-session: `workspace.manage`, workspace |  |  | plain Hono | D6 |

### Inventory 3.2 row 97

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 97 | POST | `/brand-templates/:id/duplicate` | route.ts:1792 | `brandTemplateService.duplicate` | `duplicateBrandTemplateSchema` | browser-session: `brand.manage`, workspace |  |  | plain Hono | D6 |

### Inventory 3.2 row 98

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 98 | POST | `/brand-templates/logo/presign` | route.ts:1803 | `brandTemplateService.presignLogoUpload` | `presignBrandLogoSchema` | browser-session: `brand.manage`, workspace | actor `logo-presign` 30/60s |  | plain Hono | D6 |

### Inventory 3.2 row 99

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 99 | GET | `/brand-templates/:id/logo-url` | route.ts:1815 | `brandTemplateService.getLogoDownloadUrl` |  | browser-session: `content.view`, workspace |  |  | plain Hono | D6 |

### Inventory 3.2 row 100

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 100 | GET | `/audio-assets` | route.ts:1824 | `audioAssetService.listAssets` | `listAudioAssetsQuerySchema` | browser-session: `content.view`, workspace |  |  | plain Hono | D6 |

### Inventory 3.2 row 101

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 101 | POST | `/audio-assets/presign-upload` | route.ts:1847 | `audioAssetService.presignUpload` | `presignAudioUploadSchema` | browser-session: `brand.manage`, workspace | actor `audio-asset-presign` 30/60s |  | plain Hono | D6 |

### Inventory 3.2 row 102

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 102 | POST | `/audio-assets` | route.ts:1863 | `audioAssetService.finalizeUpload` | `finalizeAudioUploadSchema` | browser-session: `brand.manage`, workspace |  |  | plain Hono | D6 |

### Inventory 3.2 row 103

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 103 | GET | `/audio-assets/:id/playback-url` | route.ts:1879 | `audioAssetService.getPlaybackSource` | `audioAssetIdParamSchema` | browser-session: `content.view`, workspace |  |  | plain Hono | D6 |

### Inventory 3.2 row 104

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 104 | PUT | `/audio-assets/:id/favorite` | route.ts:1901 | `audioAssetService.setFavorite` | `audioAssetIdParamSchema` | browser-session: `brand.manage`, workspace |  |  | plain Hono | D6 |

### Inventory 3.2 row 105

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 105 | DELETE | `/audio-assets/:id/favorite` | route.ts:1920 | `audioAssetService.setFavorite` | `audioAssetIdParamSchema` | browser-session: `brand.manage`, workspace |  |  | plain Hono | D6 |

### Inventory 3.2 row 106

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 106 | DELETE | `/audio-assets/:id` | route.ts:1939 | `audioAssetService.deleteUserAsset` | `audioAssetIdParamSchema` | browser-session: `brand.manage`, workspace |  |  | plain Hono | D6 |

### Inventory 3.2 row 122

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 122 | GET | `/brand-profiles` | brand-profile-routes.ts:39 | `brandProfileService.list` |  | browser-session: `content.view`, workspace; custom zod (query) |  |  | plain Hono | D6 |

### Inventory 3.2 row 123

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 123 | GET | `/brand-profiles/:id` | brand-profile-routes.ts:48 | `brandProfileService.get` |  | browser-session: `content.view`, workspace; paramsInput("id") |  |  | plain Hono | D6 |

### Inventory 3.2 row 124

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 124 | POST | `/brand-profiles` | brand-profile-routes.ts:53 | `brandProfileService.create` | `type BrandProfileCreateInput` | browser-session: `brand.manage`, workspace; bodyInput(brandProfileCreateSchema) |  |  | plain Hono | D6 |

### Inventory 3.2 row 125

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 125 | PATCH | `/brand-profiles/:id` | brand-profile-routes.ts:59 | `brandProfileService.update` | `type BrandProfileUpdateInput` | browser-session: `brand.manage`, workspace; bodyInput(brandProfileUpdateSchema, ["id"]) |  |  | plain Hono | D6 |

### Inventory 3.2 row 126

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 126 | PUT | `/brand-profiles/:id/membership` | brand-profile-routes.ts:65 | `brandProfileService.setMembership` | `type BrandProfileMembershipInput` | browser-session: `brand.manage`, workspace; bodyInput(brandProfileMembershipSchema, ["id"]) |  |  | plain Hono | D6 |

### Inventory 3.2 row 127

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 127 | POST | `/brand-profiles/:id/set-default` | brand-profile-routes.ts:71 | `brandProfileService.setDefault` |  | browser-session: `brand.manage`, workspace; paramsInput("id") |  |  | plain Hono | D6 |

### Inventory 3.2 row 128

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 128 | DELETE | `/brand-profiles/:id` | brand-profile-routes.ts:78 | `brandProfileService.softDelete` | `type BrandProfileSoftDeleteInput` | browser-session: `brand.manage`, workspace; bodyInput(brandProfileSoftDeleteSchema, ["id"]) |  |  | plain Hono | D6 |

### Inventory 3.2 row 129

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 129 | GET | `/visual-assets` | brand-profile-routes.ts:85 | `visualAssetService.list` |  | browser-session: `content.view`, workspace |  |  | plain Hono | D6 |

### Inventory 3.2 row 130

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 130 | POST | `/visual-assets/presign-upload` | brand-profile-routes.ts:89 | `visualAssetService.presignUpload` | `type VisualAssetUploadInput` | browser-session: `brand.manage`, workspace; bodyInput(visualAssetUploadSchema) | actor `visual-asset-presign` 30/60s |  | plain Hono | D6 |

### Inventory 3.2 row 131

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 131 | POST | `/visual-assets` | brand-profile-routes.ts:95 | `visualAssetService.finalizeUpload` | `type VisualAssetFinalizeInput` | browser-session: `brand.manage`, workspace; bodyInput(visualAssetFinalizeSchema) |  |  | plain Hono | D6 |

### Inventory 3.2 row 132

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 132 | DELETE | `/visual-assets/:id` | brand-profile-routes.ts:101 | `visualAssetService.softDelete` | `type ReusableAssetSoftDeleteInput` | browser-session: `brand.manage`, workspace; optionalBodyInput(reusableAssetSoftDeleteSchema, ["id"]) |  |  | plain Hono | D6 |

### Inventory 3.2 row 133

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 133 | GET | `/projects/:projectId/generated-media/jobs` | brand-profile-routes.ts:108 | `generatedMediaService.list`, `generatedMediaService.usageSummary` | `listGeneratedMediaJobsSchema` | browser-session: `content.view`, project(projectId); custom zod (query) |  |  | plain Hono | D6 |

### Inventory 3.2 row 134

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 134 | POST | `/projects/:projectId/generated-media/jobs` | brand-profile-routes.ts:122 | `generatedMediaService.create` | `createGeneratedImageSchema` | browser-session: `content.edit`, project(projectId); bodyInput(createGeneratedImageSchema, ["projectId"]) | actor `generated-image-create` 10/60s |  | plain Hono | D6 |

### Inventory 3.2 row 135

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 135 | GET | `/projects/:projectId/generated-media/jobs/:id` | brand-profile-routes.ts:130 | `generatedMediaService.get` | `generatedMediaJobIdSchema` | browser-session: `content.view`, project(projectId); paramsInput("projectId", "id") |  |  | plain Hono | D6 |

### Inventory 3.2 row 136

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 136 | POST | `/projects/:projectId/generated-media/jobs/:id/cancel` | brand-profile-routes.ts:135 | `generatedMediaService.cancel` | `generatedMediaJobIdSchema` | browser-session: `content.edit`, project(projectId); paramsInput("projectId", "id") |  |  | plain Hono | D6 |

### Inventory 3.2 row 137

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 137 | DELETE | `/projects/:projectId/generated-media/jobs/:id/result` | brand-profile-routes.ts:140 | `generatedMediaService.deleteResult` | `generatedMediaJobIdSchema` | browser-session: `content.edit`, project(projectId); paramsInput("projectId", "id") |  |  | plain Hono | D6 |

### Inventory 3.2 row 138

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 138 | GET | `/brand-profiles/:id/scene-templates` | brand-profile-routes.ts:146 | `sceneTemplateService.list` |  | browser-session: `content.view`, workspace; paramsInput("id") |  |  | plain Hono | D6 |

### Inventory 3.2 row 139

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 139 | POST | `/brand-profiles/:id/scene-templates` | brand-profile-routes.ts:151 | `sceneTemplateService.create` | `type SceneTemplateCreateInput` | browser-session: `brand.manage`, workspace; bodyInput(sceneTemplateCreateSchema, ["id"]) |  |  | plain Hono | D6 |

### Inventory 3.2 row 140

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 140 | PATCH | `/brand-profiles/:id/scene-templates/:templateId` | brand-profile-routes.ts:157 | `sceneTemplateService.update` | `type SceneTemplateUpdateInput` | browser-session: `brand.manage`, workspace; bodyInput(sceneTemplateUpdateSchema, ["id", "templateId"]) |  |  | plain Hono | D6 |

### Inventory 3.2 row 141

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 141 | DELETE | `/brand-profiles/:id/scene-templates/:templateId` | brand-profile-routes.ts:163 | `sceneTemplateService.softDelete` | `type SceneTemplateDeleteInput` | browser-session: `brand.manage`, workspace; bodyInput(sceneTemplateDeleteSchema, ["id", "templateId"]) |  |  | plain Hono | D6 |

### Inventory 3.2 row 142

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 142 | GET | `/brand-fonts` | brand-profile-routes.ts:169 | `brandFontService.list` |  | browser-session: `content.view`, workspace |  |  | plain Hono | D6 |

### Inventory 3.2 row 143

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 143 | POST | `/brand-fonts/presign-upload` | brand-profile-routes.ts:173 | `brandFontService.presignUpload` | `type BrandFontUploadInput` | browser-session: `brand.manage`, workspace; bodyInput(brandFontUploadSchema) | actor `brand-font-presign` 30/60s |  | plain Hono | D6 |

### Inventory 3.2 row 144

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 144 | POST | `/brand-fonts` | brand-profile-routes.ts:179 | `brandFontService.finalizeUpload` | `type BrandFontFinalizeInput` | browser-session: `brand.manage`, workspace; bodyInput(brandFontFinalizeSchema) |  |  | plain Hono | D6 |

### Inventory 3.2 row 145

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 145 | DELETE | `/brand-fonts/:id` | brand-profile-routes.ts:185 | `brandFontService.softDelete` | `type ReusableAssetSoftDeleteInput` | browser-session: `brand.manage`, workspace; optionalBodyInput(reusableAssetSoftDeleteSchema, ["id"]) |  |  | plain Hono | D6 |

## Acceptance criteria

- [x] All 41 brand/media routes move with exact capabilities, optimistic revisions, membership/default/governance/asset ownership and typed generated-media degradation.
- [x] New aggregate/default/usage/retained-reference reads serve Studio/upload/recipes without 24-row truncation; retained deleted refs remain resolvable.
- [x] Profile/template/scene/asset retryable creates use atomic receipts; native generated media acceptance remains authoritative.
- [x] Presigned media/font/audio uploads remain direct; no font/image/passcode native regression in Bun container.
- [ ] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun test apps/api/src/domains/brand
bun run test:brand-profiles:db
bun run test:vizard-expansion:db
bun run --cwd apps/api typecheck
```

## Comments

Claimed and implemented by Claude (Sonnet 5.5), 2026-10-29. Paired review not run by the implementer (last acceptance box left open for the orchestrator).

### What landed
- `apps/api/src/domains/brand`: all 41 existing routes (17 relocated by 04 + the 24 of `brand-profile-routes.ts`, now deleted from web) plus the 6 chosen new reads (`GET /brand-kit`, `/brand-profiles/default?applicable=1`, `/brand-profiles/:id/usage|detail`, `/brand-templates/:id/profile|editor-assets`) = 47 admission entries; mounted routes equal the table (tested). Capabilities and operation rates copied from the inventory rows (`set-default` stays `workspace.manage`; presign rates 30/60; `generated-image-create` 10/60). Ids are UUID-validated after admission (the old unvalidated `:id` reads now return 400 `invalid_input` instead of a driver error); audio keeps its legacy `invalid_audio_asset_id`. Services get only the brand slice of the actor, never the App User.
- `aggregates.ts` (API-side `Promise.all` composition, services unchanged): kit/detail/default/usage/template-profile/editor-assets, each role-gated read stays gated (usage and replacements only for `brand.manage`; replacements also need `brand.profiles` on the plan). They return the plan facts the pages computed (`brandPlanRequirement`, count and governance requirements) so the browser imports no service. Profiles come from the new `brandProfileService.listAll` (cursor-paged, 100 per page, 5-page bound), not the 24-row default. Retained fonts resolve with `insertable:false` as before.
- Receipts (`create_brand_profile`, `create_brand_template`, `duplicate_brand_template`, `create_scene_template`, listed in `brand-receipt-commands.ts`): each service `create/duplicate` takes an optional `IntegrationMutation` (autopilot pattern; the many DB-gate callers stay unreceipted). Row and receipt commit in one transaction; scene keeps its serializable isolation via a serializable receipt persistence. Authorization on replay is a live `requireActor(brand.manage)`. Profile receipt result is `{id}` only (signed asset URLs never stored); the response is read fresh. Routes require `Idempotency-Key`, declare `deferRateRefusal`, and enforce the recorded limiter in `beforeAccept`, so replay beats 429/503.
- Not receipt-wrapped, by design: asset finalize (visual/font/audio) is already naturally idempotent (unique fingerprint / storage key, `replayed` flag); generated media keeps its body `idempotencyKey` job store; scene apply keeps `CampaignOperation` + `Campaign-Retry-Of`.
- `packages/validators/src/api/brand.ts` (query schemas), `packages/api-client/src/brand/{client,queries,mutations}.ts` (`brandQueries`, `brandMutations`, `invalidateBrand`; signed links `staleTime 0`, job polling 3 s only while a job can change).

### Requests for other owners
- 31 (or 04): `packages/api-client/src/index.ts` should `export * from "./brand"` (it currently re-exports only `createBrandClient/BrandClient/BrandRoutes`), otherwise 20 cannot import `brandQueries/brandMutations/invalidateBrand`.
- 31: add `packages/services/src/brand-receipts.db.test.ts` to `packages/services/scripts/run-brand-profile-db-tests.ts` (the runner executes one fixed file; I ran the new file through a temp copy of the runner under the same env). Delete the now-unused `brand-commands.ts` / `brand-commands-runtime.ts` skeletons (and the `index.ts` exports of them) in the final cleanup; receipts live on the services, nothing uses `createBrandCommands`.
- 20: `invalidateBrand` also invalidates `recipes`, `ingest/configuration`, `studio/editor-assets` and `studio/brand-snapshot` for the Workspace; if 14/16 name those resources differently, adjust the list in `queries.ts` (Studio's working document key is deliberately not touched).
- 04/spec: `rpc-types.check.ts` still compiles against the new routes. The spec lists no capability for the new reads; I chose `content.view` except `/brand-profiles/:id/usage` = `brand.manage` (its only consumer is the delete dialog, which the page showed to managers only).

### Evidence
- `bun test apps/api/src/domains/brand packages/api-client/src/brand` -> 58 pass (routes 33 incl. admission, 400/403/409/429/503 envelopes, idempotency-key matrix, literal-before-param order, route/table parity; aggregates 11; client 14).
- `.scratch/api-extraction/db-gate.sh bun run test:brand-profiles:db` -> 37 pass; `test:vizard-expansion:db` -> 17 + 4 + 3 pass. New `brand-receipts.db.test.ts` through the same gate environment -> 11 pass (replay, changed-input conflict, 5-way same-key race for profile/style/scene, limiter enforced for new work and skipped on replay, replay re-authorization, plan-limit refusal leaves no receipt, `listAll` returns 30 > 24).
- `bun test packages/services/src/generated-media.test.ts` -> 26 pass (unchanged service). `operation-receipt.test.ts` registry test currently fails on another domain's name `review.round.create` (not matching `^[a-z][a-z0-9_]*$`; reviews/27).
- `bunx biome check` on my paths clean. `tsc` (apps/api, packages/api-client, packages/services): no errors in my files. Remaining errors are others': api `domains/rest/routes.ts` (23), `reviews/guest-replay-child.ts` (27), `studio/bootstrap.ts` (13; its `Map` of `insertable` flags has the same typing issue I fixed in `aggregates.ts`), `workspace/routes.ts` (05); services `clips-commands.ts` (11); api-client `clips/mutations.ts` (11). `apps/api/scripts/check-route-inventory.ts` could not load while validators lacked 05's `inviteTokenParamSchema` export, so inventory parity was verified by the route/table test instead; rerun it once 05 lands.
- `bun run test:integration-api:db`/others not run (outside scope).
