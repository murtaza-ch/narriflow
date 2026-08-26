# Campaign bulk operations

**Status:** implementation-ready

**Vizard references:** `Bulk export and download`, 22 May 2025; `Bulk schedule and post videos`, 28 July 2025; `Bulk Schedule Clips + Clip Again`, 14 November 2025.

## Outcome

An editor can take a selected set of project clips through styling, export, client review, download, and scheduling without repeating the same form for every clip.

## User experience

- Keep the current clip checkboxes, select-all behavior, sorting, and `Render selected` action.
- When at least one clip is selected, show a persistent campaign command bar with one solid primary action based on state. Before export it is `Prepare exports`; after exports are ready it is `Send for review` or `Schedule`, according to approval policy.
- Secondary actions live in `More actions`: apply Brand Profile, apply style preset, apply intro or outro, apply motion, download ZIP, and clear selection.
- Opening an action shows the selected count, eligibility summary, expected output variants, estimated usage where relevant, and clips that require attention.
- Results appear in one operation drawer with per-item state. Users may retry failed or stale items without repeating successful items.
- Selection remains stable while the user changes sort or opens a clip. It resets when the project changes or the user explicitly clears it.

## Campaign Operation contract

Add a durable Campaign Operation with:

- project, workspace, actor, action kind, idempotency key, status, requested count, outcome counts, validated options, and timestamps
- one immutable item per selected clip with expected editor revision, optional export ID, status, error code, and result reference
- statuses `queued`, `running`, `completed`, `partial`, `failed`, and `cancelled`
- item statuses `pending`, `succeeded`, `unchanged`, `stale`, `ineligible`, and `failed`

Action kinds in the first program are `apply_brand`, `apply_style`, `apply_scene_template`, `apply_motion`, `prepare_exports`, `export_bundle`, `create_review`, and `schedule_posts`.

A Campaign Operation is an audit and idempotency record. It does not claim worker ownership. `prepare_exports` creates immutable Clip Export requests through the current service. `export_bundle` creates or binds an `export_bundle` Workflow Run. Database-only actions settle inside their service transaction.

## Operation rules

- Validate project ownership, capability, entitlement, clip membership, and selection bounds before creating items.
- A client-minted idempotency key plus project and action kind identifies one submission.
- Every mutation carries the editor revision or export fingerprint it inspected. Changed clips become `stale` rather than receiving an action based on old state.
- Multi-item work uses bounded chunks. A transaction never locks every clip in a large project at once.
- Repeating an already-successful item returns `unchanged`. Retry creates a new operation linked to the original and includes only retryable items.
- A partial operation remains terminal and truthful. Successful items are not rolled back because another clip failed.
- Selection limits and concurrency limits live in shared configuration and are enforced server-side.

## Export bundle

- The user chooses ready export variants or requests missing exports first.
- The service freezes the selected export variant IDs and filenames before queueing the Workflow Run.
- The worker streams files into a ZIP without loading all media into memory. It writes to an attempt-scoped R2 key and publishes the final object only after archive completion.
- The bundle manifest lists included and excluded items, variant, byte size, and stable failure code. It contains no signed URLs.
- Bundle filenames are sanitized and collision-safe. Directory layout is project, clip title plus stable index, then aspect ratio.
- A bundle expires under a configurable delivery retention policy. Expiry does not delete the underlying Clip Exports.

## Selection-scoped style application

- Reuse the same caption, transition, background, framing, Brand Template, and Scene Template validators used by single-clip Studio.
- Apply changes through Clip Editor Document revisions and the service interfaces that already preserve stale export history.
- Do not add a second JSON patch format for bulk operations.
- The response states which clips changed, were already equivalent, were stale, or were ineligible.

## Scheduling handoff

- Bulk scheduling creates draft Social Posts from selected approved exports and connected accounts.
- Validate provider capability, aspect ratio, caption length, thumbnail support, account status, approval policy, and scheduled time before item creation.
- Use workspace timezone for user input and store UTC.
- Hand completed drafts to the existing social publisher. Campaign Operation does not publish media itself.

## Permissions, entitlements, and analytics

- `content.edit` controls style and scene actions. `content.download` controls bundles. `review.manage` controls review creation. `publishing.manage` controls scheduling.
- Pro and Business may create Campaign Operations. Business receives approval-aware defaults and audit history.
- Record operation kind, requested count, outcome counts, duration, retry relation, and plan tier. Never record clip titles, captions, or URLs.

## Migration and rollout

1. Add Campaign Operation tables and read-only operation history.
2. Move current Render selected through the new audit contract without changing visible behavior.
3. Add export preparation and ZIP delivery.
4. Add selection-scoped brand, style, scene, and motion actions.
5. Add review creation and scheduling only after their feature contracts are stable.

## Acceptance criteria

- Duplicate submissions create one logical operation and never duplicate exports, bundles, review rounds, or Social Posts.
- Stale revisions, mixed eligibility, one failed worker item, expired accounts, and unavailable assets produce per-item outcomes.
- A ZIP contains only the frozen ready variants and remains downloadable until its stated expiry.
- Existing Studio apply-to-all and Render selected behavior still work.
- Permission and entitlement checks run in services, not only in the UI.
- Operation history is readable after downgrade without allowing new premium actions.

## Out of scope

- Cross-project selections.
- Arbitrary bulk editor-document patches.
- CSV campaign import, recurring schedules, or a new publishing worker.
- Google Drive delivery.

