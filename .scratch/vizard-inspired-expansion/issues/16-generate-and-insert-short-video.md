# 16 — Generate and insert short video

**What to build:** Extend the proven Generated Media Job contract to short video, then insert finalized results as B-roll or video Scene Blocks.

**Blocked by:** [Generate and insert still images](09-generate-and-insert-still-images.md) and [Add reusable and insertable Scene Blocks](08-add-reusable-and-insertable-scene-blocks.md).

**Status:** in-progress — entry gate closed

**Remaining evidence:** Select and register an approved video adapter only after image production evidence exists, then prove provider-specific errors, real-media transcode/export/delete behavior, Studio history, resource budgets, and cohort rollout.

**Specification:** [Generated B-roll and visual assets](../features/generated-media.md)

## Entry gate

- [ ] Image jobs have production evidence for idempotency, moderation, usage settlement, cancellation, result ingestion, deletion, reconciliation, and Studio insertion.
- [ ] Product configuration names an approved video provider, model alias, maximum duration, concurrency, and usage unit.

## Observable acceptance criteria

- [ ] The provider adapter implements asynchronous submit, waiting, poll, cancellation where supported, and normalized usage.
- [x] Video options are bounded to supported aspect ratios and durations and validated before usage reservation.
- [x] Completed output is guarded, probed, fingerprinted, and saved as a Visual Asset with duration and audio metadata.
- [ ] Studio inserts video at the playhead, replaces selected B-roll, saves it to a Brand Profile, and preserves editor history and export preparation.
- [x] Generated video never becomes new project source media or starts moment detection.
- [x] Unknown provider outcomes, long waiting, late completion after cancellation, and duplicate callbacks reconcile without double charge or duplicate asset.

## Tests and failure injection

- [ ] Provider tests cover every lifecycle transition and documented error family.
- [ ] Real-media tests cover codec normalization, duration, aspect ratio, optional audio, preview, four-target export, and asset deletion.
- [ ] Resource tests enforce download, probe, transcode, storage, polling, and worker concurrency budgets.

## Shared lifecycle evidence — 31 August 2026

- The provider-neutral lifecycle tests cover bounded video input, asynchronous waiting and polling, cancellation, safe poll retry, late completion, unknown outcomes, duplicate settlement, usage retention, and nonblocking `reconciliation_required` jobs without starting ingest or moment detection.
- The guarded ingestion contract records probed video duration, dimensions, codecs, and optional-audio metadata, but only with deterministic fake-provider fixtures. The shared 102-test/314-assertion generated-media gate and 24-test/315-assertion disposable-schema Vizard gate are green.
- No generated-video provider or model has been approved or registered. There are no provider-specific, real-media transcode/export/delete, resource-budget, browser, live-provider, or deployed cohort results; the entry gate and every corresponding checkbox remain closed.

## Rollout

- [ ] Enable for internal accounts, then a capped Pro cohort, then Business. Keep independent image and video controls.

## Scope boundaries

- [x] Do not generate long-form source media, clone faces or voices, or expose a raw provider catalog.

## Fresh-task handoff

Implement with `/tdd`, use the selected provider's official documentation, finish with `/code-review`, and run provider, usage, real-media, resource, browser, typecheck, and repository tests.
