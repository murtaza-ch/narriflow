# Publishing expansion and assisted copy

**Status:** implementation-ready

**Vizard references:** `Introducing the Social Media Calendar`, 23 January 2025; `Bulk schedule and post videos`, 28 July 2025; `Auto schedule supports all channels`, 23 January 2026.

## Outcome

Editors can prepare approved campaign exports for every supported account, including Facebook, and generate editable platform copy that follows the selected brand. The interface only offers thumbnail controls that the destination accepts.

## Existing behavior to preserve

- TikTok, YouTube Shorts, Instagram Reels, LinkedIn, and X account and publishing flows.
- Direct Instagram Reels connection through the current Meta OAuth service.
- Social Post statuses, due-post worker polling, retries, error codes, Calendar, project Publish tab, metrics, and analytics.
- User-edited caption as the final value sent to a provider.

## Facebook publishing

- Add `facebook_reels` to the shared platform validator and Prisma enum through an additive migration.
- Extend the current Meta authorization flow to request and validate Page permissions, list eligible Pages, and store the selected Page as a distinct Social Account.
- Store provider Page ID and required publishing metadata inside the existing encrypted Social Account contract. Never store a user token where a Page token is required.
- Add the Facebook Reels publisher behind the same Social Publisher interface and status transitions.
- Treat account expiry, revoked permission, missing Page role, media rejection, processing timeout, and provider rate limit as stable failure codes.
- Do not change the Instagram branch while adding Facebook.

## Provider capability matrix

Define one shared, versioned capability table per platform:

- supported aspect ratios and duration limits
- caption and hashtag length rules
- whether uploaded, extracted-frame, or generated thumbnails are accepted
- whether a first-comment or title field exists
- whether provider processing requires polling
- publish and scheduling availability

The web app, validators, scheduling service, and worker consume this table. A provider-specific constraint must not be copied into four call sites.

Capability values that may change at the provider remain configuration or adapter facts. Persist the capability version used to validate a Social Post so support can explain later failures.

## Thumbnail workflow

- Where supported, choose an uploaded Visual Asset, a generated image, or a frame extracted from the selected immutable Clip Export.
- Frame extraction is an asynchronous, idempotent media operation keyed by export variant and source time.
- Persist a durable thumbnail asset ID and fingerprint in Social Post metadata. Do not persist a signed URL.
- Hide thumbnail controls on unsupported providers and explain when an existing thumbnail will be ignored after a destination change.
- Never burn a thumbnail into the opening video frame as a fallback unless the editor explicitly adds a Scene Block.

## Assisted social copy

- `Generate copy` uses the reviewed clip title, hook, payoff, platform, Brand Profile voice guidance, and user-entered campaign note.
- Generate separate platform variants. Each result contains caption body, hashtags, optional title, model, prompt version, and moderation outcome.
- The editor reviews and edits every result before scheduling. Generation never creates or publishes a Social Post by itself.
- Regeneration may preserve locked phrases or hashtags selected by the editor.
- The service logs prompt version and token usage, not source transcript or generated copy.
- Invalid or unavailable Brand Profile guidance falls back to a neutral Narriflow prompt and tells the user which guidance was skipped.

## Approval integration

- Scheduling resolves the exact Clip Export and asks Review Service for approval eligibility.
- If the Brand Profile or Review Round requires approval, an unapproved or newer export is ineligible.
- Owners and admins may supply an override reason through the Review Service. The resulting Social Post stores the audit reference.
- Editing post copy or a provider thumbnail does not invalidate video approval. Selecting a different export does.

## Bulk scheduling

- Campaign Operations prepare one item per clip, account, and scheduled occurrence.
- The scheduling form supports account selection, start date, workspace-local posting window, frequency, and generated-copy review.
- Convert to UTC only after validating the workspace timezone. Daylight-saving transitions return explicit ambiguous or nonexistent-time guidance.
- Duplicate submission with the same idempotency key returns the same Social Posts.
- Invalid items remain drafts or operation failures. Valid items schedule successfully.

## Entitlements and permissions

- `social.manage` controls account connection. `publishing.manage` controls copy, thumbnails, scheduling, cancellation, and publishing.
- Creator and above may generate assisted copy for supported existing platforms.
- Pro and Business may use bulk scheduling and custom thumbnail media operations.
- Facebook follows the same paid publishing policy as the other direct platforms.
- Business approval gates remain enforced after downgrade for already-configured projects, while new Business-only review workflows are blocked.

## Analytics and observability

Record account connection outcome, copy generation outcome, copy accepted or edited, thumbnail source kind, schedule operation outcome, publish outcome, and provider capability version. Do not record generated text, hashtags, tokens, account credentials, or signed URLs.

## Acceptance criteria

- Instagram account connection and publishing contract tests remain unchanged and passing.
- Facebook Page selection cannot cross workspace ownership or publish through an unselected Page.
- Every platform renders controls from the same capability table used by server validation.
- Unsupported thumbnails cannot be submitted by calling the API directly.
- Assisted copy is never scheduled without an explicit editor confirmation.
- Approval checks use exact export revisions and reject stale approval.
- Bulk schedules survive partial validation, duplicate submission, timezone transitions, expired accounts, and provider rate limits.

## Out of scope

- Adding platforms other than Facebook Reels or Pages.
- Automatic publishing without review of generated copy.
- Replacing the existing Calendar or Social Publisher lifecycle.
- Fabricating thumbnail support where the provider API does not offer it.

