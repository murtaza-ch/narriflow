# 15 — Add assisted copy, thumbnails, and bulk scheduling

**What to build:** Generate reviewed platform copy, prepare provider-supported thumbnails, and schedule selected approved exports through Campaign Operations.

**Blocked by:** [Migrate Brand Kit with Brand Template compatibility](03-migrate-brand-kit-with-template-compatibility.md), [Build selection-scoped campaign actions](11-build-selection-scoped-campaign-actions.md), [Enforce Review approval in publishing](14-enforce-review-approval-in-publishing.md), and [Add Facebook and a provider capability contract](07-add-facebook-and-provider-capability-contract.md).

**Status:** done

**Specification:** [Publishing expansion and assisted copy](../features/publishing-expansion.md)

## Observable acceptance criteria

- [x] Copy generation uses platform, clip facts, campaign note, and frozen Brand Profile voice guidance.
- [x] Each platform result is editable and requires explicit editor confirmation before Social Post creation.
- [x] The UI hides unsupported thumbnail controls and supports uploaded Visual Assets, generated images, and extracted export frames where allowed.
- [x] Frame extraction is asynchronous, idempotent, and produces a durable Visual Asset reference.
- [x] Bulk scheduling validates account, export revision, approval, aspect ratio, text, thumbnail, timezone, and posting window per item.
- [x] Valid items schedule when other items fail, and retries do not duplicate Social Posts.
- [x] Existing Calendar, single-post scheduling, cancellation, and publisher polling remain compatible.

## Tests and failure injection

- [x] Copy tests cover missing guidance, moderation failure, timeout, regeneration with locked terms, user edits, and duplicate submission.
- [x] Thumbnail tests cover unsupported providers, missing objects, bad frame time, extraction retry, and asset deletion.
- [x] Scheduling tests cover daylight-saving gaps and overlaps, expired accounts, partial approval, rate limits, and idempotency.
- [x] Logs and analytics contain no generated copy, hashtags, prompt content, or URLs.

## Rollout

- [x] Enable assisted copy, then thumbnails, then bulk scheduling.
- [x] Keep every step editor-confirmed during this program.

## Scope boundaries

- [x] Do not auto-publish generated copy or fabricate thumbnail support.

## Fresh-task handoff

Implement with `/tdd`, finish with `/code-review`, and run content, media, social, calendar, browser, typecheck, and repository tests.
