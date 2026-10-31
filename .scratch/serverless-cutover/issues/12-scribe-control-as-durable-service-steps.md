# 12 - Scribe control as durable service steps

**What to build:** Scribe control as durable service steps.

**Blocked by:** 03, 04, 05, 07, 08, 09

**Status:** ready-for-agent

**Spec:** [Serverless cutover](../spec.md)

- **Build:** move `transcribe.ts` control into `packages/services/src/transcription*.ts` with persisted immutable audio. Native language extraction runs in Modal. Explicit-language and supplied-caption paths preserved. Targeted waits replace result sweeps. Concurrency is weighted.
- **Accept:** intent recorded before POST. Callback and GET share the finalizer. Duplicate or stale callbacks are no-ops. No full-video fallback for STT. No container or connection waits on transcription.

## Evidence

Pending implementation and verification.
