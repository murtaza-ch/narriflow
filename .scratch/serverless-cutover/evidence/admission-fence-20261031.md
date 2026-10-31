# Authoritative admission fence — 2026-10-31

This is implementation and disposable-PostgreSQL evidence. It does not record an
operational close, cutover or reopen of the shared development deployment.

`readExecutionAdmission(tx)` takes `ExecutionEpoch FOR SHARE` as the first
admission lock. New-work transactions check `admissionOpen` before committing
their new work. Closing or advancing the singleton therefore waits for earlier
admissions. The failure is the existing expected-domain unavailable response,
`execution_admission_closed`. There is no global HTTP middleware or environment
override for this authority.

Exact authorized durable replay remains available while closed. Completion,
artifact commit, provider callbacks, expiry, delivery retry, cleanup and frozen
already-admitted pipeline transitions do not require new root admission. A new
finishing suboperation is new work even when its parent was already admitted.
Its driver must park without spending a retry budget while admission is closed.

| New-work entrypoint | Authoritative seam |
| --- | --- |
| Link, Drive, RSS and Zoom media intake; manual re-admission | `ProcessingUsage.reserve` checks fresh or released reservations; existing reservations replay. RSS/Zoom episode transactions lock epoch before rule/connection locks. `IngestJobLifecycle.retry` also checks before retry mutation. |
| Upload Session opening, including calls without optional quota admission | `prismaUploadSessionPersistence.reserve`: epoch, Workspace usage, existing-session replay, then open check and create. Existing grants, finalization and handoff remain available. |
| Project generation and configuration finalization | `ProjectService.triggerGeneration` guards new generation after exact reusable-run lookup in both receipt and ordinary paths; `finalizeGenerationSetup` guards committing new setup. |
| Regeneration, ordinary render requests, root dubbing and export-bundle requests | `WorkflowRunLifecycle.admit`, standalone `admitTranscript` and standalone `admitWithHandoff`. Caller-owned atomic handoff from an already admitted ingest remains a continuation. |
| Ordinary render variant create/reset | `admitClipRendering` commits epoch/open, variant create/reset, run and dispatch together. Active-run reuse is retained. Closed exact run replay cannot reset completed variants. The former separate ClipRender transaction is removed. |
| Explicit versioned export and failed-export retry | `ClipExportService.create` receipt mutation and `WorkflowRunLifecycle.retryFailedClipExport`. Exact operation receipts return before a new mutation. |
| Brand font/visual validation | `NativeValidationService.admit`, after existing immutable job replay and before creating a new validation row. |
| Thumbnail-frame request | `ThumbnailFrameExecution.request`, after exact key/frame replay and before creating a row. |
| Generated image | `GeneratedMediaExecution.create`, after exact job/fingerprint replay and before usage or job creation. |
| RSS preview or a new autonomous feed occurrence | `OutboundProbeService.admit`, after exact occurrence/input replay and before creating the probe. |
| Publication scheduling, slot/grant acceptance, proposal acceptance | `prismaPublicationSchedulingStore.open`, before slot/grant or frozen publication mutation; exact committed posts replay. Manual Publish again is owned by the publication controller agent and must use the same fence. |
| Autopilot rule creation, activation/source changes, Run now and Take over | New-work transactions check the shared authority. Pausing remains allowed closed. A fresh due-rule claim returns unclaimed while closed, without fetching the feed or spending a failure attempt. |
| Assisted social copy | `prismaAssistedCopyStore.open` now uses one epoch-locked, replay-first transaction before creating a provider generation. |
| Synchronous content repurposing and Clip title suggestions | A short authoritative admission transaction precedes the existing provider POST. No PostgreSQL lock spans provider HTTP. These retain their current synchronous service contract. |
| Mutations wrapped in an Operation Receipt | `prismaOperationReceiptPersistence.lock` takes epoch before the receipt advisory lock. It does not reject closed by itself; the domain distinguishes new work from completion/replay. |

Verification:

- Fresh migration remains closed: separate ledger process, 10 cases/11 assertions.
- Full execution services: 174 cases/1,191 assertions, plus the separate ten
  ledger cases/11 assertions. The focused admission suite passes six cases/23 assertions.
- Publication/render/assisted-copy suite: 39 cases/204 assertions, including an
  injected WorkflowRun insert failure rolling back ordinary render variant writes.
- Closed checks prove no new usage reservation, Upload Session, native job,
  Workflow, publication or assisted-copy generation. Exact durable replay works;
  an admitted native job can prepare while closed. Concurrent close waits for the
  active shared admission transaction. Autopilot can pause but cannot trigger,
  take over or claim a fresh occurrence.
- Services typecheck, focused Biome, 136 existing fast admission cases/427
  assertions and 11 copy/content fast cases/29 assertions pass.

Test runners explicitly open their disposable schema after migration. The
execution runner first tests the actual closed migration seed in a separate
process. The deployed-selection fixture explicitly closes its isolated gate and
proves already-admitted finalization still works. Product code has no test bypass.

Remaining integration obligations: deployed close/open smokes, manual Publish
again fence merge, finishing-driver parking, deletion/replacement of obsolete
scanner admission paths (including `queueFollowUpRenderRun`), and the ticket24
single operational reopen. Billing reconciliation is a completion path owned by
ticket19 and is not blocked by this root-work fence. This map does not close
ticket24 or claim the old consumers have been stopped.
