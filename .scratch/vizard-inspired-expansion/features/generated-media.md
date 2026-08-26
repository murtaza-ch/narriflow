# Generated B-roll and visual assets

**Status:** implementation-ready

**Vizard reference:** `Generate Motion Graphics, Videos, and Images in the Editor`, 6 March 2026.

## Outcome

An editor can generate a relevant still image from transcript context or a manual prompt, save the result, and place it in a clip. The same workflow later accepts short generated video without changing Studio or asset ownership.

## Release boundary

The first release generates still images only. Short generated video is a later issue blocked by production evidence from image job creation, moderation, usage settlement, asset insertion, deletion, retry, and provider failure.

Motion-graphics generation is excluded. Editors can animate a generated still with the bounded Motion feature.

## User experience

- Add Generate inside Studio's Media inspector beside B-roll and uploads.
- Start from a selected transcript range, an existing B-roll cue, or a manual prompt.
- Show the derived context separately from the editable prompt. Users can remove context before submission.
- Choose aspect ratio and an approved style preset. Provider model names remain an advanced deployment choice, not a default user decision.
- A submitted job remains visible if the editor closes the panel or leaves Studio.
- Successful results appear in a small result gallery with Insert at playhead, Replace selected B-roll, Save to Brand Profile, Download, and Delete.
- Insertion creates a normal Visual Asset placement or Scene Block and enters Studio history. Generation itself does not mutate the Clip Editor Document.
- Video generation uses the same gallery and actions after its release, with duration and source-audio metadata.

## Generated Media Job

Persist:

- owner, project, optional clip, actor, media kind, status, idempotency key, and attempt count
- provider and configured model alias
- encrypted prompt ciphertext, a keyed prompt fingerprint for idempotency, and a terminal retention deadline
- prompt origin kind and source IDs without copying full transcript into analytics or logs
- aspect ratio, requested duration for video, style options, and seed where supported
- provider job reference, waiting state, next poll time, error code, moderation outcome, usage reservation, finalized usage, and timestamps
- resulting Visual Asset ID and insertion state

Statuses are `queued`, `running`, `waiting`, `completed`, `failed`, `rejected`, and `cancelled`. Waiting external work releases its worker claim and resumes by provider reference.

## Provider interface

Define a private `GeneratedMediaProvider` contract with:

- submit image or video request
- poll asynchronous request where required
- cancel where supported
- normalize moderation and safety rejection
- normalize billable usage
- fetch or stream the completed media
- report retry disposition without exposing provider errors to callers

The first adapter uses `OPENAI_API_KEY` and configured `OPENAI_IMAGE_MODEL`. Do not hardcode a dated model name. Video uses a configured adapter and model only after the video issue starts.

Provider calls use bounded timeouts, retries for documented transient outcomes, and idempotency where supported. A retry must not create two settled assets or charge usage twice.

## Moderation and prompt handling

- Validate prompt length and supported options before reserving usage.
- Run the provider's required safety checks and map rejection to a stable `generated_media_rejected` outcome.
- Do not silently rewrite a rejected prompt. Explain that it could not be generated and let the user edit it.
- Keep prompts out of structured logs, analytics, notification payloads, and support URLs.
- Apply the same tenant and project authorization to prompt-derived source IDs as to the clip itself.
- Delete prompt ciphertext thirty days after a terminal job. Retain the non-content job, usage, moderation, provider alias, and asset references required for billing and audit.

## Usage settlement

- Reserve generation usage atomically before provider submission.
- Finalize only the provider-confirmed successful units represented by the saved asset.
- Release the reservation for validation failure, moderation rejection, terminal provider failure, or confirmed cancellation.
- A timeout with unknown provider outcome stays waiting or reconciliation-required. It does not refund and resubmit blindly.
- Keep generation usage separate from processing minutes and expose a typed usage summary to billing and the UI.

## Asset ingestion

- Fetch provider output through guarded egress rules, verify content type and size, probe media, compute a fingerprint, and upload to an attempt-scoped R2 key.
- Publish the Visual Asset row and final object reference atomically enough that a completed row never points at a missing attempt object.
- Reconcile orphaned attempt objects and completed provider jobs that crashed before finalization.
- A generated asset uses the same read, picker, reference, soft-delete, and hard-delete rules as an uploaded Visual Asset.

## Insertion and rendering

- Insert an image as manual B-roll over a bounded range or as an image Scene Block at the playhead.
- Store asset ID and fingerprint in the Clip Editor Document. Resolve a fresh signed URL at preview or render boundaries.
- Generated video is probed and inserted as a video Scene Block or B-roll placement. It never becomes new source media for moment detection in this program.
- Studio and the Clip Composition Plan treat uploaded and generated visual assets identically after finalization.

## Entitlements and limits

- Free may receive one configured image trial. Creator and above may generate images. Pro and Business may generate short video after release.
- Generation requires available metered usage even when the creative feature is entitled.
- Per-workspace concurrency, prompt length, image count, video duration, output size, and daily abuse limits are server-configured.
- Downgrade keeps completed assets readable and usable in existing documents but blocks new jobs outside the remaining entitlement.

## Analytics and observability

Record media kind, provider alias, model alias, status, latency bucket, retry count, moderation outcome, usage units, insertion outcome, and plan tier. Never record prompts, transcript context, signed URLs, or provider output payloads.

## Acceptance criteria

- Duplicate submission cannot create duplicate provider charges or assets.
- Failed, rejected, and cancelled jobs do not finalize usage.
- Unknown provider outcome is reconciled before refund or retry.
- Cross-workspace prompt source IDs, result IDs, and asset IDs fail closed.
- Completed images can be inserted, previewed, exported, saved to a Brand Profile, soft-deleted, and retained by existing references.
- Leaving Studio does not lose job progress, and a reopened session adopts only results that still belong to the project.
- Video support cannot be enabled until all image acceptance checks and production guardrails pass.

## Out of scope

- Training custom models, generating long-form source video, motion-graphics generation, face cloning, automatic insertion without editor review, or exposing raw provider model catalogs.
