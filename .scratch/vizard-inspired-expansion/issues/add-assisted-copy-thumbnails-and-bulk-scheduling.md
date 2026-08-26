# Add assisted copy, thumbnails, and bulk scheduling

**What to build:** Generate reviewed platform copy, prepare provider-supported thumbnails, and schedule selected approved exports through Campaign Operations.

**Blocked by:** [Migrate Brand Kit with Brand Template compatibility](migrate-brand-kit-with-template-compatibility.md), [Build selection-scoped campaign actions](build-selection-scoped-campaign-actions.md), [Enforce Review approval in publishing](enforce-review-approval-in-publishing.md), and [Add Facebook and a provider capability contract](add-facebook-and-provider-capability-contract.md).

**Status:** ready-for-agent

**Specification:** [Publishing expansion and assisted copy](../features/publishing-expansion.md)

## Observable acceptance criteria

- [ ] Copy generation uses platform, clip facts, campaign note, and frozen Brand Profile voice guidance.
- [ ] Each platform result is editable and requires explicit editor confirmation before Social Post creation.
- [ ] The UI hides unsupported thumbnail controls and supports uploaded Visual Assets, generated images, and extracted export frames where allowed.
- [ ] Frame extraction is asynchronous, idempotent, and produces a durable Visual Asset reference.
- [ ] Bulk scheduling validates account, export revision, approval, aspect ratio, text, thumbnail, timezone, and posting window per item.
- [ ] Valid items schedule when other items fail, and retries do not duplicate Social Posts.
- [ ] Existing Calendar, single-post scheduling, cancellation, and publisher polling remain compatible.

## Tests and failure injection

- [ ] Copy tests cover missing guidance, moderation failure, timeout, regeneration with locked terms, user edits, and duplicate submission.
- [ ] Thumbnail tests cover unsupported providers, missing objects, bad frame time, extraction retry, and asset deletion.
- [ ] Scheduling tests cover daylight-saving gaps and overlaps, expired accounts, partial approval, rate limits, and idempotency.
- [ ] Logs and analytics contain no generated copy, hashtags, prompt content, or URLs.

## Rollout

- [ ] Enable assisted copy, then thumbnails, then bulk scheduling.
- [ ] Keep every step editor-confirmed during this program.

## Scope boundaries

- [ ] Do not auto-publish generated copy or fabricate thumbnail support.

## Fresh-task handoff

Implement with `/tdd`, finish with `/code-review`, and run content, media, social, calendar, browser, typecheck, and repository tests.

