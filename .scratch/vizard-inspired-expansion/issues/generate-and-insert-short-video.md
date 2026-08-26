# Generate and insert short video

**What to build:** Extend the proven Generated Media Job contract to short video, then insert finalized results as B-roll or video Scene Blocks.

**Blocked by:** [Generate and insert still images](generate-and-insert-still-images.md) and [Add reusable and insertable Scene Blocks](add-reusable-and-insertable-scene-blocks.md).

**Status:** ready-for-agent

**Specification:** [Generated B-roll and visual assets](../features/generated-media.md)

## Entry gate

- [ ] Image jobs have production evidence for idempotency, moderation, usage settlement, cancellation, result ingestion, deletion, reconciliation, and Studio insertion.
- [ ] Product configuration names an approved video provider, model alias, maximum duration, concurrency, and usage unit.

## Observable acceptance criteria

- [ ] The provider adapter implements asynchronous submit, waiting, poll, cancellation where supported, and normalized usage.
- [ ] Video options are bounded to supported aspect ratios and durations and validated before usage reservation.
- [ ] Completed output is guarded, probed, fingerprinted, and saved as a Visual Asset with duration and audio metadata.
- [ ] Studio inserts video at the playhead, replaces selected B-roll, saves it to a Brand Profile, and preserves editor history and export preparation.
- [ ] Generated video never becomes new project source media or starts moment detection.
- [ ] Unknown provider outcomes, long waiting, late completion after cancellation, and duplicate callbacks reconcile without double charge or duplicate asset.

## Tests and failure injection

- [ ] Provider tests cover every lifecycle transition and documented error family.
- [ ] Real-media tests cover codec normalization, duration, aspect ratio, optional audio, preview, four-target export, and asset deletion.
- [ ] Resource tests enforce download, probe, transcode, storage, polling, and worker concurrency budgets.

## Rollout

- [ ] Enable for internal accounts, then a capped Pro cohort, then Business. Keep independent image and video controls.

## Scope boundaries

- [ ] Do not generate long-form source media, clone faces or voices, or expose a raw provider catalog.

## Fresh-task handoff

Implement with `/tdd`, use the selected provider's official documentation, finish with `/code-review`, and run provider, usage, real-media, resource, browser, typecheck, and repository tests.

