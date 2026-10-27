# Public REST API v1

The public reference is the marketing page at `/developers/api`; the
OpenAPI 3.1 document is served at `GET /api/v1/openapi.json`. This page is
for people who run and change the API. [ADR 0013](../adr/0013-integration-surfaces.md)
records the design.

## Where things live

- `apps/web/app/api/v1/[[...route]]/route.ts` mounts the app. It is a
  separate Hono app, not part of the browser API or its declaration
  inventory. `apps/web/proxy.ts` lets `/api/v1` bypass Clerk.
- `apps/web/lib/rest-api/app.ts` holds the routes; REST envelopes live in
  `packages/validators/src/rest-api.ts`. `REST_ENDPOINT_COMMANDS` maps every endpoint to one
  integration command.
- `packages/services/src/integration-admission.ts` is the command table
  shared with MCP. `integration-commands.ts` holds the shared commands,
  derived keys, and resource views.
- `packages/services/src/operation-receipt.ts` is the Operation Receipt
  executor. `completion-callback.ts` and `completion-callback-runtime.ts`
  hold Completion Callbacks; the worker's `completion_callbacks` loop runs
  them.

## Rules

- Only Workspace API keys (`nf_…`) authenticate. OAuth bearer tokens are
  out of scope for v1.
- Requests that start work need `Idempotency-Key`. Upload grants,
  finalize, and discard are keyed by the Upload Session ID instead.
- Rate limit: 300 requests a minute per key, in the `rest:<apiKeyId>`
  bucket. While Upstash is unavailable, reads and receipt replays proceed
  and new mutations return `503 mutations_unavailable`.
- Changes within v1 are additive. The OpenAPI document is snapshot-tested
  (`apps/web/lib/rest-api/__snapshots__`); review any snapshot diff for
  removed or tightened fields before updating it. Breaking changes need
  `/api/v2`.
- No publishing, Autopilot management, review creation, content suite, or
  cancellation endpoints in v1. REST only proposes posts (below).

## Captioned videos

`POST /captioned-videos` (command `create_captioned_video`) captions a
finished short with no clip detection. Its settings (`framing`, caption source,
export formats) freeze into the generation's Content Pack as `captionedVideo`
with `mode: "caption_only"`, so the single path described below reads one
record. A link is accepted like `POST /projects`; a file opens an Upload
Session carrying the same Content Pack, finished with `POST /uploads/{id}/finalize`.
MCP has `narriflow_create_captioned_video` for links.

- **Whole-source clip.** `Clip.wholeSource` selects `clipDurationBounds(true)`,
  1 to 180 seconds, instead of the detected-clip 10 to 120. The persistence
  codec (encode and decode), the boundaries request, the ingest handoff, the
  detection stage, and the Studio's trim handles all read it. The frozen export
  snapshot carries it so the render worker decodes the same window.
- **Where speech-to-text is skipped.** Only `processTranscriptRun`
  (`apps/worker/src/tasks/transcribe.ts`), by `planTranscript` in
  `packages/validators/src/captioned-video.ts`: supplied or declined captions,
  and any source whose probe shows no audio stream. The transcript completes at
  once with supplied (normalized, cut to the source) or empty utterances.
- **Where the export is made.** The worker completes detection with
  `completeMomentDetection(attempt, { admit })`, where `admit` is
  `ClipExportService.captionedExportWrite`. The export is written in the
  transaction that marks the run completed, so it is visible exactly when the
  run is: a detection retry cannot leave one behind, and the export's
  settlement cannot overlap the run's. The completion event freezes the export
  (`generationExport`), and the export's first final outcome is recorded once on
  the detection run (`generationExportResult`). The generation's Operation
  Status and its `operation.finished` follow that record: a retried export
  updates the export's own operation, and deleting the export afterwards changes
  nothing. The status reader takes only the framing and formats from the stored
  settings (a JSON-path read), never the 64 KiB of supplied captions.
- **Where a clip ends.** Windows end at the source's exact probed duration
  (`clipSourceEdgeSec`), because `Project.sourceDurationSeconds` is rounded and
  can be half a second short; a source that rounds to 3 minutes (up to 180.4
  seconds) qualifies.
- **Notices.** Operation Status `notices` carries `framing_degraded` per
  requested format when Center's cover crop discards part of the source frame
  (derived from the stored probe, not persisted).
- **Limits.** The ingest handoff refuses a captioned video's window over 3 minutes or
  under 1 second (`whole_source_too_long`, `whole_source_too_short`) before
  settlement. Supplied captions are 64 KiB and 1,000 cues at most, refused with
  `supplied_captions_*` codes at acceptance.

## Completion Callbacks

- A Workspace needs a signing secret (Settings → API) before any request
  may include `callback.url`; otherwise acceptance returns
  `409 callback_secret_required` and no work starts.
- URLs and secrets are sealed with AES-256-GCM under a key derived from
  `SOCIAL_TOKEN_ENCRYPTION_KEY`, which web and worker must share.
- `COMPLETION_CALLBACK_POLL_INTERVAL_MS` (worker, default 5000) sets how
  often the loop looks for due rows. Each waiting row backs off on its own
  from 15 seconds to 5 minutes.
- Logs: `completion_callback_attempt` records Workspace, operation, event
  ID, host, attempt, status, duration, and disposition. They never carry
  the URL path, query, or payload.

## Workspace Events

[ADR 0014](../adr/0014-workspace-events.md) records the design. The user
guide is `apps/web/content/docs/api/events.mdx`.

- `packages/services/src/workspace-event.ts` owns the tables:
  `appendWorkspaceEvent`, `listWorkspaceEvents`, and the retention delete.
  Nothing else writes them. `operation-finished.ts` and
  `social-post-finished.ts` derive the two settlement event types, and
  the transition hooks call them inside their own transactions.
  `generation-finishing.ts` writes `finishing.finished`, from its own hook
  and from the finishing worker.
- Add a type by extending `packages/validators/src/workspace-event.ts`, then
  queue its event from the transaction that makes the change, with a
  `dedupeKey` that names the transition: the same on a replay, different on
  the next outcome. The transaction must end with `flushWorkspaceEvents`; the
  Workflow Run lifecycle's wrapper does it for every lifecycle command, any
  other transaction calls `appendWorkspaceEvent` (queue and flush) as its last
  act. Never write events mid-transaction: the flush takes the Workspace
  counter, which must be the last lock. Add its DB test beside the
  transition's other tests.
- `WorkspaceEventKey` rows remember every dedupe key after the 30-day purge
  deletes the event. They go with their Project or Workspace.
- Apply the migration before deploying: every settlement writes
  `WorkspaceEventKey` and `WorkspaceEvent`, and exports read
  `ClipExport.retryCount`.
- The worker's `maintenance` loop deletes events older than 30 days, one
  batch of 1,000 a minute, and logs `workspace_events_purged`. The counter
  row stays, so `seq` never repeats.
- `GET /events` and `narriflow_list_events` are the `list_events` command.
  Posting outcomes and queue proposals need `publishing:read`: types the
  credential can't see are filtered out of a page that also names visible
  ones, but a request naming only hidden types is refused with
  `scope_required` and `details.scope` (an empty page would read as "nothing
  happened").
- `order=desc` (default `asc`) reads the newest `limit` matching events,
  newest first, from the `[workspaceId, seq]` index backwards. It has no
  cursor to continue from, so `order=desc` with `after` is `400
  invalid_request` (checked in the command, so REST and MCP agree). Its
  `nextCursor` is the page's highest `seq`, a forward cursor that never points
  back; an empty page returns the counter's head read before the page, so an
  event committed in between is not skipped. It is for pollers that read the
  newest page each poll and deduplicate by `id`, and it covers at most `limit`
  (200) matching events per poll interval; a busier feed needs `after`.

## Webhook Subscriptions

[ADR 0014](../adr/0014-workspace-events.md) records the design. The user
guide is `apps/web/content/docs/api/webhooks.mdx`.

- `packages/services/src/webhook-subscription.ts` owns the management
  service (`list`, `create`, `delete`, `enable`, `test`) and the delivery
  processor; `webhook-subscription-runtime.ts` is the production wiring.
  Delivery is `deliverCallback` from `completion-callback.ts`: the same
  sealed URL, signing secrets, Standard Webhooks signature, pinned guard,
  and `nextAttemptDelayMs` backoff.
- `lastDeliveredSeq` is the only cursor, and it moves only after a 2xx. An
  idle pass moves it to the Workspace counter's head, read before the
  events, so a subscription filtered to a quiet type doesn't mistake expired
  events of other types for a gap. `retentionFloor` (oldest retained `seq`
  minus one, or the head when nothing is retained) is the lowest cursor that
  lost nothing; a cursor below it disables the subscription with
  `cursor_expired`. `enable` raises the cursor to the floor.
- Ordering across workers: the processor claims one subscription at a time,
  right before draining it, and before every POST it renews the lease in a
  statement that also requires the cursor to still be below that event. A
  worker whose lease lapsed finds the row taken (or the cursor passed) and
  sends nothing; the cursor update repeats the same condition. A tick runs
  four lanes (`WEBHOOK_CONCURRENCY`) with a 20 s budget
  (`WEBHOOK_TICK_BUDGET_MS`) and stops between events when it is spent, so
  one slow endpoint holds one lane. Never two lanes on one subscription.
- Disabled reasons: `consecutive_failures` (20), `endpoint_gone` (410),
  `cursor_expired`. Re-enabling sets `skipExpiredOnResume`; the next drain
  moves the cursor past events that expired meanwhile, so a purge before the
  first drain can't disable it again.
- The worker's `webhook_deliveries` loop emails the creator while they are
  still a Workspace member, otherwise the owner, once per disabling
  (`disabledNotifiedAt` is written first). A send that goes out or fails
  stays final. A skipped send (no app base URL or no Resend key) is unmarked, logged as
  `webhook_disabled_notice_skipped`, and retried after five minutes.
- `POST /webhooks/{id}/test` allows one test per webhook every 5 seconds
  (`lastTestedAt`, `webhook_test_throttled`), for REST and Settings alike.
  Enable and test check the webhook's event types against the key's scopes.
- The loop uses `COMPLETION_CALLBACK_POLL_INTERVAL_MS`; a caught-up
  subscription is looked at again every 5 seconds. Logs:
  `webhook_delivery_attempt` and `webhook_subscription_disabled` carry
  Workspace, webhook ID, host, event ID, `seq`, status and duration, never
  the URL or payload.
- `list_webhooks` (`projects:read`) and `manage_webhooks` (`processing:write`)
  are the commands. Creating with `social_post.proposed` or `social_post.finished` also needs
  `publishing:read`, as in the feed. Apply the `WebhookSubscription`
  migration before deploying the worker.

## Publishing Queue

[ADR 0015](../adr/0015-publishing-queue.md) records the design. The user guide
is `apps/web/content/docs/publishing-queue.mdx`.

- `POST /social-posts/proposals` (`propose_social_post`, `publishing:write`)
  and `GET /social-accounts` (`list_social_accounts`, `publishing:read`) are
  the REST routes; `narriflow_propose_social_post` is the MCP tool. They share
  `proposeSocialPost` and `socialAccountsView` in `integration-commands.ts`,
  which call `publishingQueue` in `publishing-queue.service.ts`. REST never
  accepts, schedules or publishes; the body cannot carry a time.
- A proposal is an Operation Receipt keyed by user, command and
  `Idempotency-Key`, so a retry through REST or MCP replays. Its post, proposal
  row and `social_post.proposed` event commit with the receipt.
- Acceptance is browser-only (`publishing.manage`): server actions in
  `app/(app)/calendar/queue/actions.ts` call `publishingQueue.accept`,
  `acceptAll`, `reject` and `updateProposalCaption`.
- `test:social-publication:db` covers invisibility to the scheduler and
  recovery, concurrent accepts, the approval gate and TikTok. Apply the
  `publishing_queue` migration before deploying.

## Recipes

A [Recipe](../../GLOSSARY.md) is a named, revisioned set of Workspace settings
(`Recipe` table): a Brand Profile, language, Content Pack, and finishing.
Writes stay in the browser (`/api/recipes`, the Recipes page). REST and MCP
read them: `GET /recipes`, `GET /recipes/{id}`, and `narriflow_list_recipes`,
all under the `list_recipes` command (`projects:read`). The view shows the
generation settings an inline request would send, not Content Pack internals.

- `recipeId` is an alternative to inline settings on `POST /projects`,
  `POST /uploads`, and `POST /projects/{id}/generations`, and on
  `narriflow_submit_video`, `narriflow_upload_video`, and
  `narriflow_generate_clips`. With it, `brandProfileId`, `generation`, and
  `finishing` are refused as a validation error (`refuseRecipeWithInlineSettings`,
  and again in the command). A generation takes the Recipe's generation
  settings and finishing; the Project keeps the Brand Profile it was imported
  with.
- The Recipe is resolved after the receipt replay lookup, in the receipt's
  `prepare` step (`RecipeUse.resolve`), so the fingerprint holds only the ID.
  The accepted result stores `recipe: { id, revision }`, which REST and MCP
  return. An Upload Session fingerprints the ID, resolves in its admission
  after finding no session for the key, and stamps `recipe` onto its stored
  generation settings. A retry after an edit or delete replays; a new key sees
  the edit or `recipe_not_found`.
- A session opened with a Recipe returns `recipe: { id, revision }` in the
  open response (REST, the connector's upload route, and the local upload
  command's output), read back from the session's stored settings by
  `UploadSessionService.recipeUsed`. Content Packs keep the same pair in
  `ContentPack.recipe` for every Recipe-backed intake, including Autopilot's,
  so a Project records which revision it started from.
- A Recipe is shared but a rule runs as its creator. `onRecipeContentChanged`
  (`recipe.service.ts`) is the single hook called inside `RecipeService.update`'s
  transaction with the ids of the rules that use the Recipe, for any save that
  changes what new work uses. It pauses the active standing grants covering
  those rules (`rule_changed`, with the grant audit and notice) and the save
  flushes the events last; the lock order is Recipe, rules by id, grants. Such
  a save also bumps `Recipe.contentRevision`, which the grants' rule
  fingerprint covers (a rename bumps `revision` only). The save's response lists rules
  whose member can't manage publishing (`warnings`, never blocking), and the
  finishing runner checks `publishing.manage` again before proposing to a queue,
  ending the row `partial` with `actor_lacks_publishing` otherwise.
  `narriflow_create_rss_autopilot_rule` checks `publishing:write` against the
  Recipe's finishing as the rule is saved.
- Finishing that proposes to the queue is checked as the Recipe is read: the
  credential needs `publishing:write` and the acting user needs queue rights,
  exactly as for inline finishing.
- Autopilot rules require `recipeId` and carry no settings. Saving a rule
  (create, or moving it to another Recipe) and saving a Recipe both run the
  checks the rule used to run on its own fields: the Brand Profile must apply
  now, finishing needs the plan (`campaign.operations`), and queue delivery
  needs `publishing.manage` and active accounts. A Recipe used by a rule cannot
  be deleted. The migration `20261024210000_recipes` created one Recipe per
  distinct setting an existing rule carried (per Workspace) and pointed the
  rules at it; `recipe-migration.db.test.ts` runs it against a schema built
  from the earlier migrations.
- The Recipes gates are `recipe.db.test.ts` and `recipe-migration.db.test.ts`
  under `test:integration-api:db`, and the Autopilot cases in
  `test:vizard-expansion:db`.

## Finishing

[Finishing](../../GLOSSARY.md) exports a generation's best clips and writes
assisted copy once the generation completes, so an n8n flow or script ends at
"ready to review" without a person. The user guide is in
`apps/web/content/docs/api/n8n.mdx` and `ai/tools.mdx`.

- `finishing` is an optional field on `POST /projects`, `POST /uploads`, and
  `POST /projects/{id}/generations`, and on `narriflow_submit_video`,
  `narriflow_upload_video`, and `narriflow_generate_clips`. One schema,
  `finishingSettingsSchema`, serves these requests and Recipes. The
  field is part of the request fingerprint, so a replay with other settings is
  a conflict. The browser's generate route doesn't take it:
  `triggerGeneration` accepts finishing only beside an integration mutation.
- It rides in the existing `generationContext` (`buildGenerationContext`) from
  acceptance to the Ingest Generation Handoff. Intake writes it to the new
  Content Pack's `finishing` column; the handoff, or `generate_clips`
  admission, freezes it as one `GenerationFinishing` row keyed by the
  generation's speech-to-text run, in the admission transaction.
  `freezeGenerationFinishing` refuses any other run.
- The first freeze wins. A replay finds the same row. A `generate_clips`
  request that reuses a generation and asks for other finishing, or for
  finishing that already ran, gets `generation_settings_conflict`, as a
  different Content Pack does. A handoff that finds its generation already
  admitted by another path freezes the intake's finishing onto that run if none
  exists, and keeps a different existing row (logged as
  `ingest_finishing_conflict_ignored`), since an intake has no caller to refuse.
- The row starts `waiting`. `queueFinishedGenerations` in
  `operation-finished.ts`, where the generation's `operation.finished` is
  derived, moves it to `due` (generation `completed` or `partial`) or
  `skipped` (`failed`, `cancelled`) as a plain update in the same transaction.
  That is the only change on the Workflow Run lifecycle's critical path, and
  `test:workflow:db` covers it.
- The worker's `finishing` loop (`FINISHING_POLL_INTERVAL_MS`, default 15000;
  `FINISHING_BATCH_SIZE`, default 3) first wakes rows parked as `exporting`
  whose exports are all terminal, in one statement that claims nothing, then
  claims `due` rows with a five-minute lease and runs
  `createGenerationFinishing().processDue`. Before it picks clips it checks
  the plan (`campaign.operations`, Pro and above) and that the acting user still
  has access; below that the row ends `skipped` with `plan_required`, and
  imports are unaffected. After exports exist, a plan or access that no longer
  qualifies ends the row `partial` with that reason and the exports it has. It
  picks clips from the generation's lineage at or above `minScore`, best first,
  up to `topClips`, and keeps them on the row. "Best" is the plain virality
  score unless the Workspace has Performance Guidance in force
  (`readAppliedGuidance`): then it is score times a factor held to 0.8 to 1.25
  from the clip's category and exported length, and a clip only overtakes
  another whose plain score is within 15 points. Each pick keeps `ranking`
  (score, factor, the groups behind it, and when the guidance was computed).
  `minScore` is always checked against the plain score.
- Exports go through `clipExportService.create` with the UUIDv5 key
  `finishingExportKey(finishingId, clipId, revision)`. A clip edited since it
  was picked is exported at its new revision under that revision's key. An
  earlier export of the same revision and formats that failed is requeued with
  `clipExportService.retryFailed`, the Exports page's own path. Copy goes
  through the assisted copy service with `finishingCopyKey(finishingId,
  clipId, attempt)`, one call per clip for all chosen platforms. A re-claim
  resumes from the stored picks, and the keys make a repeat return what the
  first attempt made, so nothing is exported or written twice.
- A copy failure that is transient (the provider or store unavailable or
  rate limited, an earlier attempt that never settled, or an unexpected error)
  counts the pick's `copyAttempt` up and releases the row to back off, so the
  retry has a fresh key; an attempt costs one of the row's five. Any other copy
  failure is final for the clip and ends the row `partial` with `copy_failed`.
- The row ends `ready`, `partial`, or `skipped` in one transaction that also
  queues and flushes its `finishing.finished` event. The "clips ready"
  notification goes first, as the `finishing_ready` outcome with the row's id
  as its source, so a crash retries both. It goes to the acting user's email
  (`NotificationStore.getFinishingDelivery`); every other outcome still goes to
  the Workspace owner.
- With `delivery: "propose_to_queue"` and `queueAccountIds`, the runner checks
  the accounts are still active, adds their platforms to the copy it writes,
  and after copy proposes each usable pick to each account through
  `publishingQueue.propose` under `finishingQueueKey(finishingId, clipId,
  accountId)`. A refused proposal sets the pick's `queueError` and ends the row
  `partial` with `queue_failed`; an account that is no longer active ends it
  `partial` with `queue_account_unavailable`. Each account's outcome is kept
  on the pick (`queue`), so one refusal doesn't stop the others. When an
  Recipe or an inline request is saved, `assertFinishingQueue` requires
  `publishing.manage` for the acting user, active accounts of the Workspace and
  an export format each platform takes; `requireQueueDeliveryScope` adds the
  `publishing:write` scope for REST and MCP credentials.
- The migration added `AutopilotRule.finishing` (now `Recipe.finishing`),
  `ContentPack.finishing`, and `GenerationFinishing`. Apply it before deploying: every generation
  settlement reads the table.

## Standing Grants

Grants are managed only in Settings, by Owners and Admins (`workspace.manage`);
REST and MCP have no command to create, renew, pause or revoke one, and read
them only through events.

- `grant.paused` and `grant.expired` are Workspace Events with IDs-only
  subjects (`grantId`, `kind`, `autopilotRuleId`, and `reason` for the pause).
  They need no scope beyond `projects:read`. `grant.paused` is queued in the
  transaction that pauses the grant, which for a failed or needs-attention post
  is the one `emitSocialPostFinished` ends; `grant.expired` by the worker's
  maintenance sweep.
- Finishing `delivery: "send_review_round"` belongs to Autopilot rules. Inline
  REST and MCP requests are refused with `finishing_review_delivery_rule_only`,
  because the grant that allows it is granted for a rule.
- A publish grant accepts a rule's finishing proposals through
  `acceptProposalUnderGrant`, and a review grant sends the round through
  `sendReviewRoundUnderGrant`; neither can pass an approval override.

## Verification

`bun run test:integration-api:db` covers receipts, callbacks, Operation
Status, MCP Tasks, the Workspace Event feed (ordering, retention, and
REST and MCP parity), Webhook Subscriptions (ordered delivery, retry,
disabling, re-enabling, and retention), and the finishing runner in a disposable schema. Event emission at each
settlement, and finishing's freeze and transition, are covered by `test:workflow:db`, `test:social-publication:db`,
and `test:vizard-expansion:db`. The REST contract suite is
`apps/web/lib/rest-api/app.test.ts`, and
`apps/web/lib/integration-admission-parity.test.ts` checks every REST
endpoint and MCP tool against its browser peer. The n8n template has its
own acceptance runs in [n8n/README.md](n8n/README.md).

## Clients

The n8n templates live in [n8n/](n8n/README.md). The Zapier app is a
standalone npm project in `integrations/zapier` (outside the Bun workspaces and
Biome); its README covers pushing it and its tests, and CI runs it as its own
job. It reads the event feed statelessly: each poll is one
`GET /events?order=desc&limit=100`, so changing `order`, the `types` filter or
the 403 for hidden types affects it.

The Make app is the definition of a Make custom app in `integrations/make` (plain
JSON that Make interprets, outside the Bun workspaces and Biome); its README covers
deploying it with Make's VS Code extension and its checks, and CI runs them as the
`Make app` job. Unlike the Zapier app it keeps a cursor: Make hands the trigger the
last `seq` it returned, and each poll reads
`GET /events?order=asc&after=<seq>&limit=100` and pages on with `nextCursor`, so
changing `seq`, `nextCursor`, the `after` semantics or the rule that `order=desc`
cannot take `after` affects it. Its Epoch panel reads `order=desc` without `after`.
