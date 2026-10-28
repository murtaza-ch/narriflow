# 20. Convert Brand Kit UI

**What to build:** Brand Kit pages/actions use API aggregates and queries without the current 24-row list truncation or backend types in web.

**Blocked by:** [19 - Move Brand Kit and media controls](19-move-brand-kit-and-media-controls.md), [07 - Move billing API and convert billing UI](07-move-billing-api-and-convert-billing-ui.md)

**Status:** ready-for-agent

**Suggested implementer:** Claude. The other pairing side reviews and returns findings to this owner.

Read [spec.md](../spec.md). It is the complete contract; the original brief/plan/reviews are not prerequisites. Claim this ticket before editing.

## Exact ownership

Paths are repo-relative. Every existing file below is exclusively assigned for this phase, including files that only need verification. A new `/**` directory includes its local tests/helpers, not adjacent directories. Read other files as evidence; do not edit them.

Existing files:

- `apps/web/app/(app)/brand-kit/[id]/loading.tsx`
- `apps/web/app/(app)/brand-kit/[id]/page.tsx`
- `apps/web/app/(app)/brand-kit/[id]/scene-template-manager.tsx`
- `apps/web/app/(app)/brand-kit/_components/brand-fonts.test.tsx`
- `apps/web/app/(app)/brand-kit/_components/brand-fonts.tsx`
- `apps/web/app/(app)/brand-kit/_components/brand-kit-loading.tsx`
- `apps/web/app/(app)/brand-kit/_components/brand-kit-ui.tsx`
- `apps/web/app/(app)/brand-kit/_components/brand-profile-create-form.tsx`
- `apps/web/app/(app)/brand-kit/_components/brand-profile-default-button.tsx`
- `apps/web/app/(app)/brand-kit/_components/brand-profile-delete-button.tsx`
- `apps/web/app/(app)/brand-kit/_components/font-manager.tsx`
- `apps/web/app/(app)/brand-kit/_components/profile-audio-list.tsx`
- `apps/web/app/(app)/brand-kit/_components/profile-audio-picker.tsx`
- `apps/web/app/(app)/brand-kit/_components/profile-editor.tsx`
- `apps/web/app/(app)/brand-kit/_components/profile-fields.tsx`
- `apps/web/app/(app)/brand-kit/_components/profile-font-roles.tsx`
- `apps/web/app/(app)/brand-kit/_components/profile-membership.test.tsx`
- `apps/web/app/(app)/brand-kit/_components/profile-membership.tsx`
- `apps/web/app/(app)/brand-kit/_components/profile-styles.tsx`
- `apps/web/app/(app)/brand-kit/_components/template-form.tsx`
- `apps/web/app/(app)/brand-kit/_components/template-gallery.test.tsx`
- `apps/web/app/(app)/brand-kit/_components/template-gallery.tsx`
- `apps/web/app/(app)/brand-kit/loading.tsx`
- `apps/web/app/(app)/brand-kit/new/loading.tsx`
- `apps/web/app/(app)/brand-kit/new/page.tsx`
- `apps/web/app/(app)/brand-kit/page.tsx`
- `apps/web/app/(app)/brand-kit/style-actions.ts`
- `apps/web/app/(app)/brand-kit/styles/[id]/loading.tsx`
- `apps/web/app/(app)/brand-kit/styles/[id]/page.tsx`
- `apps/web/app/(app)/brand-kit/styles/new/loading.tsx`
- `apps/web/app/(app)/brand-kit/styles/new/page.tsx`

New files/directories or reserved skeletons handed off by a blocker:

- Add tests beside the owned implementation only; no new cross-domain directory.

Consume the endpoint contracts owned by 19. API changes belong to those owners; this ticket owns caller conversion and cache effects.

## Endpoints, actions, pages and refresh sites

Rows retain their section/ordinal or exact source-line identifier from the independent inventory. Abbreviated table filenames are accompanied by the literal ownership manifest and exact source occurrences below. All action/page/fetch/refresh rows in owned files are in scope, including no-refresh callers and media navigation. Baseline observations do not override the spec's selected origins, route style, guest Bearer or new endpoints.

### Inventory 2.B page/type row at inventory line 236

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/(app)/brand-kit/page.tsx` (298) | content.view L31 | `brandProfileService.list(scope)` L43; `brandProfileService.getDefaultId` L44; `brandTemplateService.list` L45; `brandFontService.list` L46; `brandPlanRequirement`, `brandCountRequirement`, `planCountRequirement`, `planFeatureRequirement`, `featureUpgradePrompt` | `searchParams.tab` (`profiles\|styles\|fonts`) | none | `BrandTabs`, `ProfileCard` (name, colors, logoUrl, preset, isDefault, approvalRequired, subtitle, stats), `FontLibrary{fonts,canManage}`, `FontUploadButton`, `LockedButton`, `PlanLimitNotice`, template gallery | Existing `GET /api/brand-profiles` (limit 24 default; page wants all), `GET /api/brand-templates` (`{mine,builtIn,...}`), `GET /api/brand-fonts`. **NEW**: default id (`GET /api/brand-profiles/default` or include `defaultId` in list response). |

### Inventory 2.B page/type row at inventory line 237

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/(app)/brand-kit/new/page.tsx` (58) | `admitWorkspacePage("brand.manage")` L12 | `brandProfileService.list(scope)` L13; `brandCountRequirement`, `planFeatureRequirement`, `planUpgradeHighlight` | none | none | `BrandProfileCreateForm{governance}` or `PlanLimitNotice` | Existing `GET /api/brand-profiles` (count only). Plan messages derive client-side from `/api/session` tier + count. |

### Inventory 2.B page/type row at inventory line 238

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/(app)/brand-kit/[id]/page.tsx` (294) | content.view L33 | `brandProfileService.get` L45; `getDefaultId` L63; `brandProfileService.usage` L64 (manage only); `brandProfileService.list` L65 (manage only, for "move to"); sections: `brandFontService.list` L139, `brandTemplateService.list` + `brandProfileService.list` L177, `sceneTemplateService.list` L247; `brandPlanRequirement` x4 | params `id`; `searchParams`: `section, template` | `notFound()` on `BrandProfileNotFoundError` L47 | `ProfileEditorProvider{profileId,revision}`, `ProfileColorsPanel`, `ProfilePublishingPanel`, `ProfileFontRoles`, `ProfileStyleGrid`, `StyleAdder`, `ProfileAudioPicker`, `ProfileAudioList`, `SceneTemplateManager`, `BrandProfileDefaultButton`, `BrandProfileDeleteButton{usage,otherProfiles}`, `ProfileVoicePanel` | Existing `GET /api/brand-profiles/:id`, `GET /api/brand-profiles/:id/scene-templates`, `GET /api/brand-templates`, `GET /api/brand-fonts`, `GET /api/brand-profiles`. **NEW** `GET /api/brand-profiles/:id/usage` and default id. Each section is a separate query (only the active section fetches). |

### Inventory 2.B page/type row at inventory line 239

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/(app)/brand-kit/styles/new/page.tsx` (52) | `admitWorkspacePage("brand.manage")` L13 | `brandTemplateService.list` L14; `brandFontService.list` L27; `brandPlanRequirement`, `planCountRequirement`, `planFeatureRequirement` | none | none | `BrandFontsProvider{fonts,requirement,upgrade}` > `TemplateForm{mode:"create",cancelHref}` or `PlanLimitNotice` | Existing `GET /api/brand-templates`, `GET /api/brand-fonts` |

### Inventory 2.B page/type row at inventory line 240

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/(app)/brand-kit/styles/[id]/page.tsx` (96) | content.view L26 | `brandTemplateService.get` L29; `brandProfileService.resolveProfileForTemplate` L37; `brandFontService.list` L62; `brandFontService.resolveReferences` L63; `brandPlanRequirement`, `planFeatureRequirement` | params `id` | `notFound()` on `BrandTemplateNotFoundError` L32 | `BrandFontsProvider` > `TemplateForm{mode:"edit",initialTemplate,cancelHref}`, `PlanLimitNotice`, `AccessNote` | Existing `GET /api/brand-templates/:id` (L1752), `GET /api/brand-fonts`. **NEW** `resolveProfileForTemplate` (`GET /api/brand-templates/:id/profile`, or add `profileId` to the template response) and `resolveReferences` (retained fonts; same helper as Studio). |

### Inventory 5.6 refresh/fetch row at inventory line 797

| file:line | Trigger | Call | Refreshes |
| --- | --- | --- | --- |
| `brand-profile-delete-button.tsx:60` | Delete profile; `router.replace("/brand-kit")` then refresh | `DELETE /api/brand-profiles/:id` (:49, optional `replacementProfileId`) | `/brand-kit` list |

### Inventory 5.6 refresh/fetch row at inventory line 798

| file:line | Trigger | Call | Refreshes |
| --- | --- | --- | --- |
| `brand-profile-default-button.tsx:26` | "Make default" | `POST /api/brand-profiles/:id/set-default` (:16) | `/brand-kit` + `/brand-kit/:id` |

### Inventory 5.6 refresh/fetch row at inventory line 799

| file:line | Trigger | Call | Refreshes |
| --- | --- | --- | --- |
| `profile-editor.tsx:42` (on 409) and `:47` | Any profile field save (`revision` optimistic concurrency) | `PATCH /api/brand-profiles/:id` (:34) | `/brand-kit/:id` (409 reloads latest revision) |

### Inventory 5.6 refresh/fetch row at inventory line 800

| file:line | Trigger | Call | Refreshes |
| --- | --- | --- | --- |
| `profile-membership.tsx:35` (`useMembershipChange`) | Add/remove assets in profile | `PUT /api/brand-profiles/:id/membership` (:16) | `/brand-kit/:id` |

### Inventory 5.6 refresh/fetch row at inventory line 801

| file:line | Trigger | Call | Refreshes |
| --- | --- | --- | --- |
| `profile-font-roles.tsx:91` | Assign font role | `PUT /api/brand-profiles/:id/membership` (:73) | `/brand-kit/:id` |

### Inventory 5.6 refresh/fetch row at inventory line 802

| file:line | Trigger | Call | Refreshes |
| --- | --- | --- | --- |
| `font-manager.tsx:66` | Delete font | `DELETE /api/brand-fonts/:id` (:64) | `/brand-kit` fonts |

### Inventory 5.6 refresh/fetch row at inventory line 803

| file:line | Trigger | Call | Refreshes |
| --- | --- | --- | --- |
| `font-manager.tsx:227` | Upload font | `POST /api/brand-fonts/presign-upload` (:207), `PUT` presigned URL (:211), `POST /api/brand-fonts` (:217) | `/brand-kit` fonts |

### Inventory 5.6 refresh/fetch row at inventory line 804

| file:line | Trigger | Call | Refreshes |
| --- | --- | --- | --- |
| `brand-kit/[id]/scene-template-manager.tsx:67` | Create/default/delete scene template | `POST|PATCH|DELETE /api/brand-profiles/:id/scene-templates[/:sceneId]` (:63; call sites :78,:130,:162) | `/brand-kit/:id` |

### Inventory 5.6 refresh/fetch row at inventory line 805

| file:line | Trigger | Call | Refreshes |
| --- | --- | --- | --- |
| `template-form.tsx:300` | Save existing style | `updateBrandTemplateAction(id, data)` (:286) | `/brand-kit/styles/:id` (server also `revalidatePath("/brand-kit","layout")`) |

### Inventory 5.10 refresh/fetch row at inventory line 856

| Action file | Paths revalidated |
| --- | --- |
| `(app)/brand-kit/style-actions.ts:20,31,39,46,56` | `/brand-kit` (layout); `duplicateBrandTemplateAction` also `redirect("/brand-kit/styles/:id")` (:57) |

### Inventory 5 exact file occurrences: apps/web/app/(app)/brand-kit/[id]/scene-template-manager.tsx

```text
63: const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init.headers } });
67: router.refresh();
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/brand-kit/_components/brand-profile-create-form.tsx

```text
43: const response = await fetch("/api/brand-profiles", {
58: router.refresh();
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/brand-kit/_components/brand-profile-default-button.tsx

```text
16: const response = await fetch(`/api/brand-profiles/${profileId}/set-default`, {
26: router.refresh();
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/brand-kit/_components/brand-profile-delete-button.tsx

```text
49: const response = await fetch(`/api/brand-profiles/${profileId}`, {
60: router.refresh();
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/brand-kit/_components/font-manager.tsx

```text
25: const response = await fetch(url, {
66: router.refresh();
211: const uploaded = await fetch(presigned.uploadUrl, {
227: router.refresh();
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/brand-kit/_components/profile-editor.tsx

```text
34: const response = await fetch(`/api/brand-profiles/${profileId}`, {
42: if (response.status === 409) router.refresh();
47: router.refresh();
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/brand-kit/_components/profile-font-roles.tsx

```text
73: const response = await fetch(
91: router.refresh();
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/brand-kit/_components/profile-membership.tsx

```text
16: const response = await fetch(`/api/brand-profiles/${profileId}/membership`, {
35: router.refresh();
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/brand-kit/_components/template-form.tsx

```text
166: void fetch(`/api/brand-templates/${initialTemplate.id}/logo-url`)
221: const presignRes = await fetch("/api/brand-templates/logo/presign", {
238: const putRes = await fetch(uploadUrl, {
300: router.refresh();
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/brand-kit/style-actions.ts

```text
20: revalidatePath("/brand-kit", "layout");
31: revalidatePath("/brand-kit", "layout");
39: revalidatePath("/brand-kit", "layout");
46: revalidatePath("/brand-kit", "layout");
56: revalidatePath("/brand-kit", "layout");
```

Also account for the inventory's cross-domain traps: query-only actions, action forms that relied on revalidatePath, signed downloads/media, OAuth anchors, all three EventSource consumers and unload keepalive. Only the literal files above may be changed by this ticket.

### Inventory 2.D page/type row at inventory line 285

| Client file | Types |
| --- | --- |
| `(app)/brand-kit/_components/brand-profile-delete-button.tsx` | `BrandProfileUsage` |

### Inventory 1.7 function `createBrandTemplateAction(input)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:17` | `createBrandTemplateAction(input)` | `brandTemplateInputSchema` (`BrandTemplateInput`) | `brandTemplateService.create` | `executeWorkspaceActionWithInput("brand.manage")` | in service | created template / failure | `revalidatePath("/brand-kit","layout")` | `brand-kit/_components/template-form.tsx:270` (then `router.push("/brand-kit/styles/:id")`:284) | existing `POST /api/brand-templates` (route.ts:1758) | brand-kit |

### Inventory 1.7 function `updateBrandTemplateAction(id, input)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:25` | `updateBrandTemplateAction(id, input)` | `brandTemplateUpdateSchema` (`BrandTemplateUpdate`) | `brandTemplateService.update` | `executeWorkspaceActionWithInput("brand.manage")` | in service | updated template / failure | same | `template-form.tsx:286` (`router.refresh`:300) | existing `PATCH /api/brand-templates/:id` (:1769) | brand-kit |

### Inventory 1.7 function `deleteBrandTemplateAction(id)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:36` | `deleteBrandTemplateAction(id)` | `string` | `brandTemplateService.softDelete` | `executeWorkspaceAction("brand.manage")` | none | `void` / failure | same | `brand-kit/_components/template-gallery.tsx:246` | existing `DELETE /api/brand-templates/:id` (:1780) | brand-kit |

### Inventory 1.7 function `setDefaultBrandTemplateAction(id)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:43` | `setDefaultBrandTemplateAction(id)` | `string` | `brandTemplateService.setDefault` | `executeWorkspaceAction("workspace.manage")` (note: `workspace.manage`, not `brand.manage`) | none | `void` / failure | same | `template-gallery.tsx:177` | existing `POST /api/brand-templates/:id/set-default` (:1786) | brand-kit |

### Inventory 1.7 function `duplicateBrandTemplateAction(id, newName?)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:50` | `duplicateBrandTemplateAction(id, newName?)` | `string, string?` | `brandTemplateService.duplicate` | `executeWorkspaceAction("brand.manage")` | none | never returns on success: **`redirect("/brand-kit/styles/:newId")`** | `revalidatePath`, `redirect` | `template-gallery.tsx:211` | existing `POST /api/brand-templates/:id/duplicate` (:1792) returning the new id; client navigates | brand-kit |

## Acceptance criteria

- [ ] All five Brand Kit pages and five actions plus every owned fetch/refresh site convert to queries/mutations; redirects return explicit new ids.
- [ ] Profile conflict fetches latest revision; membership/default/style/font changes invalidate exact dependents, preserving governance/usage prompts.
- [ ] Client-safe DTO types replace backend types and props used by Project/Studio/Upload remain frozen.
- [ ] No public API list default is abused to retrieve unbounded choices; aggregate/summaries retain existing page behavior.
- [ ] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun test "apps/web/app/(app)/brand-kit"
```

Verify the changed flow in the running Next app against the separate API origin. Follow the repo's runtime/browser verification guidance; record steps, result and origin pair. Do not treat compilation as browser evidence.

## Comments

Append claim, requested seam changes, paired review and evidence here.
