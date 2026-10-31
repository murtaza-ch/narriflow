# 12 - Scribe control as durable service steps

**What to build:** Scribe control as durable service steps.

**Blocked by:** 03, 04, 05, 07, 08, 09

**Status:** claimed

**Spec:** [Serverless cutover](../spec.md)

- **Build:** move `transcribe.ts` control into `packages/services/src/transcription*.ts` with persisted immutable audio. Native language extraction runs in Modal. Explicit-language and supplied-caption paths preserved. Targeted waits replace result sweeps. Concurrency is weighted.
- **Accept:** intent recorded before POST. Callback and GET share the finalizer. Duplicate or stale callbacks are no-ops. No full-video fallback for STT. No container or connection waits on transcription.

## Evidence

Preparation is in progress on the contracts worktree; dependency integration remains open. This ticket is not complete.

Protocol comparison before implementation: the [official TypeScript SDK](https://github.com/elevenlabs/elevenlabs-js/blob/main/src/api/resources/speechToText/client/Client.ts) builds multipart requests with `cloud_storage_url`/`source_url` and webhook metadata. The [official async guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/batch/webhooks) confirms webhook completion as the fast path. The existing direct-fetch adapter's explicit single POST is retained because generic SDK retry defaults cannot decide unknown provider acceptance (ADR 0018). The new service uses only immutable Source Audio; FFmpeg/file upload/full-video fallback do not enter Workers.

Implemented preparation:

- The known-origin provider client submits one `cloud_storage_url` for immutable Source Audio with explicit callback lineage, and preserves unknown-acceptance behavior without an automatic POST retry. GET recovery distinguishes pending/transient/ready/permanent outcomes. Configuration is injected.
- The strict central Provider Attempt Reference requires run/attempt, epoch, source revision and explicit Source Audio ID. The actual signed webhook route rejects incomplete/extra metadata and missing provider IDs, and logs only classified errors. Transactional provider lookups compare current epoch and Project/Transcript source lineage under epoch → Workspace → Project/run/transcript locks.
- A charged TS execution can atomically write provider intent and explicit submitted time, retain domain token as provider lineage, clear its lease and close/revoke the generic TS attempt. Fresh begin replay returns `already_waiting`; it grants no new POST permission. Deadline and immediate phase wake obligations are returned for postcommit confirmation.
- The provider-only four-hour Source Audio GET hold extends the committed source artifact's aggregate grant expiry in that transaction. It is independent of native leases and commit authority, and remains after Transcript/source revisions change.
- Raw Scribe JSON keys include source/epoch, provider identity digest and payload digest. A stale racing delivery can no longer overwrite the winner's referenced evidence. Exact duration is read by Source Audio ID/revision, with no full-video fallback.
- Active TS execution deadlines are fixed per generation. Authorized retries may rebind a new ten-minute TS control budget; Scribe's explicit submission/result deadlines own provider waiting. Ingest/Render absolute budgets remain unchanged (ADR 0019).

Verification: real isolated Postgres intent/replay/closure/epoch/source/grant gate passed 1 case, 11 assertions (`/tmp/narriflow-serverless-gates/provider-intent-grant.log`). Provider/webhook/finalizer/strict-contract suites pass 55 tests/225 assertions, including a reproduced red raw-evidence overwrite race and an independent Python SHA-256 vector. Existing provider-error suites pass; interim worker suite passes 58/161. Services/API/worker typechecks and scoped Biome pass.

Weighted admission now uses explicit `SCRIBE_MAX_CONCURRENT_UNITS`, a duration-weighted PostgreSQL capacity lock and a compound acquire/start/intent/closure transaction. Capacity denial creates neither a generic attempt nor a charge and persists the nearest provider release deadline. Real concurrent admission passed 1 case/7 assertions with the final 30-second transaction timeout. Accepted provider deadlines are fixed at the original intent time plus two hours, and retry generation/outbox transitions passed 1 case/8 assertions. Source cancellation passed 1 case/6 assertions, revoking running TS ownership and waiting provider lineage while preserving charged history. The shared cancellation and capacity helpers persist bounded continuation pointers; broad paging and runtime routing acceptance remain pending. Fast Scribe/admission/webhook/finalizer suites pass 51 tests/210 assertions.

Remaining: full durable TS service controller, confirmed callback/recovery/deadline wake delivery, capacity release/paging gates, optional same-owner native probe integration after actual STT admission, removal of the old worker control/extraction path, and integrated runtime acceptance. No paid provider call or deployment is claimed by these gates.
