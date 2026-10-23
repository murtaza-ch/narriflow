# Critical-path bug review, 2026-10-24

Five read-only reviewers covered the critical paths named in AGENTS.md. Each fix below was reproduced first and has a regression test that failed before the fix. DB tests ran on a throwaway local Postgres 17.

## Fixed

| Area | Defect | Fix | Test |
| --- | --- | --- | --- |
| Render | A text layer with `'` failed the whole export; a `%` drew nothing. Inserted text Scenes also lost `%`. | `drawtextLiteralText` in `apps/worker/src/ffmpeg-text.ts`: two-level escaping plus `expansion=none`, used for text layers, Scene text, and the watermark. Checked against a `textfile=` oracle. | Real-FFmpeg tests in `composition-ffmpeg-adapter.test.ts` (text layer, Scene text) now also reject drawtext errors on stderr. |
| Render | A Scene read the wrong `-i` when one B-roll asset was placed twice, or when resolved B-roll had extra keys. | Scene inputs start after one input per planned placement. | `reads an inserted Scene from its own input when one B-roll asset is placed twice` |
| Billing | A returning customer's new subscription stayed on Free, because the canceled canonical subscription won. | Any entitled subscription outranks the stored canonical one. | `a returning customer's new subscription replaces the canceled canonical one` |
| Billing | An `incomplete` upgrade set an existing Free Workspace to `pending_payment`, blocking processing and failing in-flight intakes. | `incomplete` keeps `pending_payment` only for a Workspace already waiting on its first payment. | `an incomplete upgrade leaves an existing Free Workspace usable` |
| Social | A post interrupted before submission (redeploy, provider deadline) showed Scheduled forever. | The Prisma `releaseInterrupted` keeps the post `publishing`, as the store contract and the in-memory store already did. | DB: `an attempt interrupted before submission is claimed again on the next poll` |
| Workflow | Bulk requeue, terminal settlement, and reaping changed export variants without recomputing the Clip Export. Exports stuck at `rendering` forever, or stayed `failed` after a retry. | `syncClipExportAggregates` runs after every bulk variant update and locks exports in id order. | DB: `Clip Export status follows bulk requeue and terminal reaping` |
| Upload | The reconciler failed a good multipart upload when the inline finalize completed it first (`NoSuchUpload`). | On `NoSuchUpload`, re-probe and adopt the object, as the inline path does. | `the reconciler adopts an upload the inline finalize completed first` |
| Upload | One transient cleanup error overwrote a compensating session's failure code. The session ended `failed` with "contact support" instead of `expired` or `aborted`. | `deferReconciliation` never replaces a compensating session's failure code. | Module and DB tests for deferral during compensation. |
| Autopilot | An episode deferred for minutes or capacity was not retried until the feed changed, because the ETag was saved and the next poll got a 304. | Don't save feed validators when an episode was deferred. | DB: `an episode deferred for capacity is retried on the next poll` |

## Deferred (verified or plausible, not fixed)

- **Captions drift after sub-100ms kept slivers** (plausible, about 100ms per sliver). `cut-plan.ts` drops kept segments under 0.1s, but `buildEditedTimeMap` (composition plan) only drops segments under 1ms, so captions, subtitles, censors, and ducking keep the sliver. One minimum must be shared.
- **Music ducking ignores inserted Scenes** (`clip-composition-plan.ts` ~773). Speech windows aren't shifted by Scene time, unlike captions and censors.
- **Text layer `bold` ignored in export.** The Studio renders weight 800/500; `textLayerFilter` always uses the regular face. This needs a font-weight selection that matches the installed caption fonts.
- **Auto Pexels cutaways never render?** `clip-render-attempt.ts` merges `brollPlan.cutaways` into the resolved assets, but the planner only receives visual B-roll placements. Confirm intent.
- **Recheck is a no-op after the deadline or budget is spent** (`social-publication-recovery.ts` ~454). Recheck doesn't extend `reconciliationDeadline` or reset `providerCallCount`. Needs a product decision on how much budget a manual recheck grants.
- **Transient credential failure during reconciliation becomes permanent Needs attention** (`social-publication-attempt.ts` ~416). Token refresh also has no lock (`social-oauth.service.ts` ~1297) and doesn't reject an empty `access_token`.
- **Reconciler dying mid-recovery locks an Upload Session for 24h.** `bindMultipartProvider` and `markSingleReady` move the row to `uploading` without clearing `reconciliationAttemptId`.
- **Late single-PUT uploads can leave orphan R2 objects.** No delayed cleanup obligation for sessions that settle without a handoff while a PUT grant is still valid.
- **One heartbeat DB error kills a workflow attempt and spends a retry** (`workflow-run-lifecycle.ts` ~1807). Graceful shutdown also spends workflow retries, while ingest refunds them. Three deploys during a long run fail it.
- **Every claim clears `requestedCount`**, so a retry after a Studio reset can send an empty "clips ready" notification. Dubbing counts only the current attempt's dubs.
- **A transient render failure can expose a `failed` export briefly** between the variant failure and the work-set requeue. The aggregate now corrects itself on requeue, but a callback observed in that gap is frozen as failed.
- Low: social claims lose their 60s lease while queued behind 4-way concurrency; callback batches outlive their lease and deliver twice (within at-least-once); same-key concurrent upload opens can return a quota refusal instead of the existing session.
