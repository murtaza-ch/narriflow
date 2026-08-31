# 15 — Add assisted copy, thumbnails, and bulk scheduling

**What to build:** Generate reviewed platform copy, prepare provider-supported thumbnails, and schedule selected approved exports through Campaign Operations.

**Blocked by:** [Migrate Brand Kit with Brand Template compatibility](03-migrate-brand-kit-with-template-compatibility.md), [Build selection-scoped campaign actions](11-build-selection-scoped-campaign-actions.md), [Enforce Review approval in publishing](14-enforce-review-approval-in-publishing.md), and [Add Facebook and a provider capability contract](07-add-facebook-and-provider-capability-contract.md).

**Status:** implementation-complete — staged rollout evidence pending

**Remaining evidence:** Run the ordered assisted-copy → thumbnail → bulk-scheduling rollout in a deployed cohort and observe real social-provider delivery and settlement. Local OpenAI copy generation and media preparation are proven, but the scheduled QA post was cancelled before provider delivery. Local failure injection proves overdue/ambiguous assisted-copy recovery, exact-key thumbnail cleanup adoption, and Social Post commit/response-loss reconciliation; those tests are not a substitute for staged provider evidence.

**Specification:** [Publishing expansion and assisted copy](../features/publishing-expansion.md)

## Observable acceptance criteria

- [x] Copy generation uses platform, clip facts, campaign note, and frozen Brand Profile voice guidance.
- [x] Each platform result is editable and requires explicit editor confirmation before Social Post creation.
- [x] The UI hides unsupported thumbnail controls and supports uploaded Visual Assets, generated images, and extracted export frames where allowed.
- [x] Frame extraction is asynchronous, idempotent, and produces a durable Visual Asset reference.
- [x] Bulk scheduling validates account, export revision, approval, aspect ratio, text, thumbnail, timezone, and posting window per item.
- [x] Valid items schedule when other items fail, and retries do not duplicate Social Posts, including a lost response after the Social Post transaction commits.
- [x] Existing Calendar, single-post scheduling, cancellation, and publisher polling remain compatible.

## Tests and failure injection

- [x] Copy tests cover missing guidance, moderation failure, known timeout, ambiguous post-dispatch loss, overdue-draft reconciliation, regeneration with locked terms, user edits, and duplicate submission.
- [x] Thumbnail tests cover unsupported providers, missing objects, bad frame time, upload/settlement crash cleanup, extraction retry, and asset deletion.
- [x] Scheduling tests cover daylight-saving gaps and overlaps, expired accounts, partial approval, rate limits, idempotency, and commit-success/response-loss reconciliation.
- [x] Logs and analytics contain no generated copy, hashtags, prompt content, or URLs.

## Local browser evidence — 31 August 2026

- A signed-in Business workspace generated a real OpenAI-assisted YouTube Shorts draft from revision-8 clip facts, a campaign note, locked terms, and the frozen Brand Profile voice. Chrome edited the title, explicitly confirmed the draft, reloaded the page, and recovered the identical confirmed wording.
- Chrome selected a durable generated image as a YouTube thumbnail and separately queued an exact TikTok frame at 7.5 seconds. The isolated worker extracted and probed the JPEG, persisted its Visual Asset, and the page recovered the completed job after reload.
- The first bulk attempt truthfully surfaced an unusable-account result. A live follow-up exposed and fixed two production seams: refreshable OAuth accounts are no longer treated as permanently expired, and an exact selected Clip Export Variant is reused rather than shadow-created. The failed-only retry then created one future Social Post from the approved revision-8 export, confirmed copy, and frozen thumbnail fingerprint. Chrome reloaded the durable scheduled row and cancelled it before any provider delivery.
- With all three publishing-preparation write controls disabled, Chrome still displayed the confirmed copy and cancelled Social Post read-only while generation, editing, confirmation, thumbnail preparation, and scheduling were unavailable. This is local rollback evidence, not the unchecked deployed ordered rollout.

## Rollout

- [ ] Enable assisted copy, then thumbnails, then bulk scheduling.
- [x] Keep every step editor-confirmed during this program.

## Scope boundaries

- [x] Do not auto-publish generated copy or fabricate thumbnail support.

## Fresh-task handoff

Implement with `/tdd`, finish with `/code-review`, and run content, media, social, calendar, browser, typecheck, and repository tests.
