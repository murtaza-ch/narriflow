# Brand profiles and asset library

**Status:** implementation-ready

**Vizard references:** `Brand kit`, 16 October 2024; `Custom Fonts Now Available in Vizard Brand Kit!`, 7 November 2024; centralized Brand Kit in `Meet the new Editor & Transitions`, 4 December 2025.

## Outcome

An agency can keep several client identities in one Narriflow workspace and apply the right identity without hunting across templates, uploads, and social forms. Existing Brand Templates continue to work as style presets.

## User experience

- The Brand Kit navigation item opens Brand Profiles. Each profile card shows its default style preset, logo, font, asset count, and whether approval is required.
- A profile has Identity, Styles, Assets, Scenes, Audio, and Voice sections. On narrow screens these are URL-driven tabs.
- Identity stores name, logo choices, colors, and font roles. Styles shows compatible Brand Templates.
- Assets shows uploaded and generated images and videos. Audio presents the existing Audio Asset library filtered to the profile's references.
- Scenes lists reusable intros, outros, and cards. Voice stores audience, tone, preferred terms, blocked terms, and hashtag guidance.
- Project creation and the project Clips tab choose one Brand Profile. The project still freezes a `brandSnapshot`; later profile edits do not rewrite existing projects.
- Studio's Brand inspector shows the selected profile and its style presets, assets, fonts, and scenes. It does not become a second Brand Kit editor.
- Existing `/brand-kit/:templateId` URLs open the owning profile with that style selected. Built-in templates continue to use the current gallery behavior.

## Domain and data

Add these durable concepts:

- `BrandProfile`: owner, name, slug, visual identity, voice guidance, default style, approval rule, timestamps, and soft deletion.
- `BrandProfileTemplate`: ordered relation from a profile to existing custom Brand Templates. One template may belong to at most one custom profile in the first release.
- `VisualAsset`: image or video metadata, R2 key, media type, byte size, dimensions, duration, fingerprint, provenance, ownership, and deletion state.
- `BrandProfileAsset`: ordered relation with a semantic role such as logo, image, video, thumbnail, intro source, or outro source.
- `BrandFont`: family name, style, weight, format, R2 key, fingerprint, license confirmation, ownership, and deletion state.
- `BrandProfileFont`: font role such as display, body, caption, or fallback.
- `BrandProfileAudio`: reference to an existing Audio Asset. Do not duplicate its storage or metadata.

Keep `Project.brandTemplateId`, `Project.brandSnapshot`, workspace defaults, user defaults, built-in templates, and every current Brand Template service method. Add `Project.brandProfileId` as a nullable relation and include a versioned Brand Profile snapshot in new projects.

## Validation and storage

- Accept PNG, JPEG, WebP, and supported MP4 or MOV visual assets. Probe media server-side before finalizing the row.
- Accept TTF, OTF, and WOFF2 fonts. Parse the font, reject collections and malformed tables, normalize the declared family and style, and enforce a bounded file size.
- Require the uploader to confirm that the workspace may use the font. Store the confirmation actor and time.
- Presign uploads beneath `workspaces/{workspaceId}/visual-assets/` or the existing personal-owner equivalent. Finalization verifies the key prefix, object metadata, MIME type, declared size, and fingerprint.
- A duplicate fingerprint may reuse the existing live asset in the same owner scope. It must never reveal another tenant's asset.
- Soft deletion removes an asset or font from pickers. Deleting a referenced object requires explicit replacement or reference removal. Historical export objects remain untouched.

## Services and interfaces

- Add validators for Brand Profile create, update, list filters, asset upload and finalize, font upload and finalize, profile membership, voice guidance, and approval defaults.
- Add `BrandProfileService`, `VisualAssetService`, and `BrandFontService`. Re-export them from the services package.
- Expose internal web routes under `/api/brand-profiles` and `/api/visual-assets`. Existing Brand Template routes remain compatible.
- Profile reads return durable IDs and short-lived access URLs as separate fields. Stored JSON never contains signed URLs.
- Project brand resolution accepts either the legacy template input or a Brand Profile plus optional style preset. If both appear during migration, the explicit profile owns the selection and the template must belong to it.

## Permissions and entitlements

- `brand.manage` controls profile, asset, font, scene, and voice changes.
- Creator and Pro profiles are personal. Business profiles belong to the workspace and can be used by all members with content-edit access.
- Free users can see built-in templates and read compatible existing data, but cannot create profiles or upload fonts and visual assets.
- Downgrades keep profiles and assets readable in old projects. New uploads, profile mutations, and premium application are blocked.

## Failure behavior

- An unavailable optional asset never prevents the Brand Kit or project from loading. Show the missing item and require replacement before new use.
- A font that cannot be resolved at render time falls back to the frozen preset's supported fallback and records a typed composition notice.
- A profile cannot be deleted while it is a workspace default. Projects retain their frozen snapshot after profile deletion.
- Concurrent profile edits use an updated-at or revision precondition and return a conflict instead of silently overwriting changes.

## Analytics

Record profile creation, project application, asset upload outcome, font upload outcome, scene-template use, and blocked premium mutations. Metadata contains only IDs, asset kind, plan tier, and outcome.

## Migration and rollout

1. Add nullable profile and asset tables plus tolerant readers.
2. Create one compatibility Brand Profile for every owner with custom templates and attach those templates in a resumable backfill.
3. Add the new Brand Kit projection while retaining old template routes.
4. Enable profile selection for new projects.
5. Enable asset and font use in Studio and rendering after preview/export parity tests pass.
6. Remove no compatibility path in this program.

## Acceptance criteria

- Existing custom and built-in Brand Templates render exactly as before migration.
- Existing default-template behavior and old Brand Kit URLs still work.
- An agency can create two profiles with different fonts, assets, scenes, and voice guidance and cannot cross-apply an asset from another workspace.
- A project freezes the selected identity and is unchanged when the source profile changes later.
- Studio and the render worker resolve the same custom font and visual asset fingerprint.
- Soft deletion, missing R2 objects, duplicate uploads, downgrade, and concurrent edit conflicts have tested outcomes.

## Out of scope

- Replacing Brand Template caption semantics.
- Migrating Audio Asset storage into Visual Asset.
- Public asset marketplaces, automatic logo extraction, or brand crawling.
- Per-project copies of every reusable object.

