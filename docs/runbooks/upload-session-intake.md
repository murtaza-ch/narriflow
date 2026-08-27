# Upload Session intake rollout and recovery

Upload Session is the only local-file intake path. The web route, browser
transfer adapter, PostgreSQL persistence, worker maintenance loop, and R2
adapter translate its commands; none of them owns a second upload state
machine. This is a pre-production direct cutover with no compatibility mode.

## Deployment order

1. Apply the complete migration chain before deploying readers:
   `bun run --cwd packages/db prisma:migrate:deploy`.
2. Run the disposable database drill: `bun run test:upload-session:db`. It
   creates a random `upload_session_test_*` schema, applies every migration,
   runs the recovery and concurrency contracts, and drops only that schema.
3. Verify the production R2 adapter against a dedicated test prefix:

   ```sh
   R2_CONTRACT_TEST_PREFIX=tests/narriflow-upload-session-cutover bun --env-file=apps/worker/.env test packages/services/src/r2-storage.test.ts
   ```

   The prefix must start with `test/` or `tests/`. Every fixture adds a UUID
   below it and cleans up in `finally`; never substitute a workspace or project
   prefix.
4. Deploy the web and worker together. There is no feature flag, shadow write,
   legacy payload, or old Project-owned upload fallback.
5. Run the authenticated browser checklist below, then watch terminal outcomes
   and reconciliation age before accepting the cutover.

## R2 browser contract

The bucket CORS policy must allow the web origins to issue `PUT` and `OPTIONS`,
allow the `Content-Type` request header, and expose the `ETag` response header.
The signed direct PUT includes the normalized media `Content-Type`; the browser
must send that exact value. Multipart part signatures do not authorize a
browser-selected part number or key: the module plans parts and grants bounded
windows.

R2 lifecycle rules should abort incomplete multipart uploads after the Upload
Session hard lifetime plus the maximum reconciliation delay. Do not configure
the provider lifecycle shorter than that envelope. The worker first attempts
owned compensation, and the provider lifecycle is the final backstop for
declared abandoned bytes.

## Runtime controls and budgets

Configuration is parsed once at process startup. Invalid, non-finite, or
out-of-range values fail startup. Relevant controls are:

- `UPLOAD_SESSION_IDLE_MS` and `UPLOAD_SESSION_HARD_LIFETIME_MS`
- `UPLOAD_RECONCILIATION_BATCH_SIZE` and
  `UPLOAD_RECONCILIATION_CONCURRENCY`
- `UPLOAD_RECONCILIATION_LEASE_MS` and
  `UPLOAD_RECONCILIATION_OPERATION_DEADLINE_MS`
- `UPLOAD_RECONCILIATION_MAX_ATTEMPTS` and
  `UPLOAD_RECONCILIATION_PROVIDER_CALL_BUDGET`
- `UPLOAD_RECONCILIATION_BACKOFF_BASE_MS` and
  `UPLOAD_RECONCILIATION_BACKOFF_CEILING_MS`

The browser budget fixtures cover medium, 1 GiB, and 5 GiB sources without
allocating their full contents. The accepted guardrails are:

| Measure | Guardrail |
| --- | --- |
| First grant | at most 2 seconds at p95 |
| One grant response | at most 128 KiB |
| Multipart browser working set | at most concurrency × part size; current fixture ceiling 64 MiB |
| Retry bytes | only the failed direct object or failed part; current multipart fixture 16 MiB |
| Steady throughput | no more than 10% below the prior signed-PUT baseline on the same network and source |
| Finalize | at most 5 seconds before switching to durable reconciliation |

A healthy small upload costs one PutObject plus one HeadObject verification and
no multipart calls. A healthy large upload costs one CreateMultipartUpload,
exactly the planned UploadPart calls, one CompleteMultipartUpload, and one
HeadObject verification, with no ListParts. ListParts and exact-key unfinished
upload inventory are recovery costs only. Class A operation counts and
`declaredAbandonedBytes` are the cost proxies to alert on.

## Diagnostics and metrics

Use the structured messages `upload_session_opened`,
`upload_session_grant_issued`, `upload_session_finalized`,
`upload_session_resumed`, `upload_session_discarded`, and
`upload_session_transition`. Together they report admission replay, transfer
kind, planned parts, grant count and latency, first-grant latency, finalize
duration, provider operation class, compensation, reconciliation, takeover,
expiry, declared abandoned bytes, and terminal outcome.

These events may include application session/workspace IDs, state, counts,
durations, and stable failure codes. They must never include signed URLs,
credentials, provider upload IDs, object keys, ETags, frozen settings, full
file names, or raw provider errors.

Alert on reconciliation age past the hard lifetime, repeated lease takeover,
attempt-budget exhaustion, compensation failure, increasing abandoned bytes,
and a terminal failure ratio above the normal baseline. A rising ListParts or
unfinished-upload inventory rate without matching resumes usually indicates
lost browser responses or provider instability.

## Incident diagnosis

1. Identify the Upload Session by application ID and inspect its state,
   reconciliation attempt, lease expiry, stable failure code, and timestamps.
2. Correlate only sanitized structured diagnostics. Never paste a signed URL,
   provider ID, raw ETag, or storage credential into logs or a ticket.
3. If the row is reconciling, let the worker retry unless its lease is stale.
   Restarting a worker is safe because claims are fenced and replay is
   idempotent.
4. For CORS failures, verify the browser origin, `PUT`, allowed
   `Content-Type`, and exposed `ETag` with the isolated R2 contract. Do not
   loosen the bucket to public access.
5. For an ambiguous completion, do not start a second provider upload. The
   module probes the exact object and unfinished upload before deciding between
   handoff and compensation.
6. For excess abandoned bytes, confirm sessions are terminal and older than
   the configured safety envelope before cleanup. Abort only the exact
   Upload Session multipart identity or delete its exact object key through the
   module/reconciler.

## Browser checklist

- Small WAV: direct upload, ETag-visible response, verification, and navigation
  into the queued Project.
- Multipart MP4: bounded grant refresh and planned-part progress.
- Pause with multiple active parts, then reselect the exact file and resume
  from server-reported completed parts with the saved settings.
- Simulated lost finalize response and repeated HTTP 202 status polling using
  `Retry-After`.
- Leave during Verifying, reopen with the exact file, and reach the same
  Project without a second transfer.
- Discard before finalization, including delayed compensation. Confirm browser
  requests settle before cleanup and no provider abort comes from the browser.
- Completed replay, quota refusal, expired session, immutable conflict,
  integrity failure, and server-proven fresh-upload recovery.
- Recheck link and RSS intake, project list/timeline, quota copy, and unchanged
  post-ingest generation.

## Rollback and cleanup

Stop the upgraded web and worker together before rolling code back. Because
there are no production users or mixed-version deployments, either keep the
new schema and resume with the upgraded code, or deliberately reset local
Upload Session rows and version-3 browser resume records. Do not restore the
removed Project upload implementation or add dual reads/writes.

Preserve Projects, Content Packs, Ingest Jobs, and objects already referenced
by a queued handoff. Cleanup must target one reviewed Upload Session ID and its
exact provider identity/key through the module. Never delete a bucket,
workspace prefix, project prefix, wildcard, or unresolved environment-derived
path. Re-run status/reconciliation after cleanup to record a terminal outcome.
