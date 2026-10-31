# Real file acceptance recipe

Prepared locally only. This helper has not contacted the candidate, storage, Modal, a provider or a database. It uses `apps/mcp/src/upload.ts`'s production `uploadVideo` implementation and the typed first-party Project client. It adds no uploader, product endpoint or credential fallback.

Root owns invocation after qualified restore, with the expected epoch rebound, Worker HTTP admission enabled and database admission explicitly open for this fixture. Do not run it against a fenced or mismatched candidate. Keep Neon Free.

Before upload, Root must remove `RESEND_API_KEY` from the isolated candidate Worker configuration and record that state. Upload Session open allocates a Project ID but does not create its row. Finalize creates the row and intake together, with the existing default `notifyOnComplete:true`; the current API therefore cannot turn that preference off before finalize. The caller immediately sets and verifies `false` through the Clerk-authenticated preference route after finalization, before it returns upload acceptance or makes a generation request. Temporary mail unavailability closes the earlier import-failure race. This is an acceptance precondition, not a product API change. Record any failed, unavailable or skipped notification outcome. Restore the candidate secret only after this exact Project's preference is observed false. Shared email configuration and `packages/email` stay untouched.

The source is the existing 22,741,661-byte, 146.147-second English speech file at `/tmp/narriflow-serverless-gates/spoken-smoke/gereon-english.webm`, SHA-256 `32b20a20e84d46d17da126689572f9a431d01ddc23880b90240952875b2a3fe8`. Source attribution and CC BY-SA 4.0 terms are recorded in `spoken-smoke-source-20261101.json`. Preparation verifies its complete local hash. No transcript, clip or successful provider outcome has been invented.

Run with the pinned Bun 1.3.6 binary from the repository root. All journal and credential files must be private. Use this one journal for every retry; never replace its keys after a lost response.

Keep `AUTH` refreshed externally from the same owned Clerk session throughout the run. The caller rereads that private credentials file before every first-party Project request, including each source-readiness poll and notification-preference request. Replace the file atomically with mode 0600 when its short-lived `sessionToken` rotates. Keep `apiKey`, `workspaceId`, and the token's issuer, user and session identities unchanged; the caller refuses an identity change before sending the Project request. The API verifies the JWT signature. The caller neither mints tokens nor receives a Clerk SDK or Clerk secret. MCP/upload authentication continues to use the original API key. Refresh adds no requests, retry, admission, or deadline.

```sh
BUN=/tmp/narriflow-serverless-gates/bun-1.3.6/bun-darwin-aarch64/bun
CALLER=apps/api/scripts/run-deployed-file-journey.ts
JOURNAL=/tmp/narriflow-serverless-control-keys/spoken-file-journey.json
AUTH=/tmp/narriflow-serverless-control-keys/cloud-auth-gate.json
API=https://narriflow-api-candidate.murtazach275.workers.dev

# Local preparation only. WORKSPACE_ID is the exact owned ID from AUTH.
# Omit this step if the supplied prepared journal already exists.
"$BUN" "$CALLER" --phase prepare --api-origin "$API" \
  --workspace-id "$WORKSPACE_ID" \
  --source-file /tmp/narriflow-serverless-gates/spoken-smoke/gereon-english.webm \
  --journal-file "$JOURNAL"

# Root executes only after restoring/opening the isolated candidate and
# recording the temporary absence of the mail credential.
"$BUN" "$CALLER" --phase upload --api-origin "$API" \
  --credentials-file "$AUTH" --journal-file "$JOURNAL"

# Same settings as the uploaded Content Pack, forceRegenerate:false.
"$BUN" "$CALLER" --phase generate --api-origin "$API" \
  --credentials-file "$AUTH" --journal-file "$JOURNAL"

# One bounded observation; rerun explicitly while status is pending.
"$BUN" "$CALLER" --phase status --api-origin "$API" \
  --credentials-file "$AUTH" --journal-file "$JOURNAL"
```

The journal records the upload key and generation key before networking, then the server's exact Upload Session, Project and Ingest Job IDs before further transfer requests. The modern MCP acceptance must return a real Task bound to the same Workspace, Project and generation Operation. That Task and Operation are saved before the accepted report. Pass the resulting journal's `taskId` and `projectId` to the separately prepared deployed HTTP acceptance caller. Its positive Tasks argument remains mandatory.

Upload freezes target 12, `under_30s`, `9:16`, language `en`, no Finishing, copy, review recipients, callbacks or social accounts. Ingest automatically hands off that exact Content Pack. The subsequent MCP `narriflow_generate_clips` call reuses matching work with `forceRegenerate:false` and a fixed acceptance key. It must never force another generation merely to obtain a Task. Base rendering requests 1080p under current plan rules and one format. This caller reports actual generation state and selected count, including fewer than 12; it does not assert a selection count or silently alter settings. Actual output resolution, bytes, quality, provider charging and native cleanup still require Root's real domain/artifact gate.

Each invocation has at most 90 requests and a fixed deadline. Upload/status have eight minutes; generation has twelve minutes and at most 60 readiness observations ten seconds apart. A source still pending returns `pending` and makes no generation call. Status performs a Project read, Task read and exact Operation read, plus a preference repair only if needed. It reports the domain's failed/partial/cancelled result without converting it to success. Signed URLs exist only in memory between the production upload response and the assigned PUT; credentials are sent only to their own API surfaces. Journals and output exclude grants, tickets, response bodies, private URLs and credentials. Raw network or provider errors are replaced by fixed failure codes at the CLI boundary.

Fixture-only verification covers the real uploader's local bytes and assigned PUT, journal-before-transfer ordering, notification disable and observed false, matching MCP input and modern Task identity, lost acceptance reply with identical retry bytes, finalized-upload replay without a duplicate PUT, finite pending readiness, token rotation during one readiness wait beyond the original token lifetime, changed credential/session refusal, and changed-file refusal. These tests establish caller behavior, not deployed acceptance. Root should also verify one admitted generation lineage and actual charged starts in the final exact fixture audit.

Cleanup belongs to Root's exact owned-fixture journal. Keep the Project, Upload Session, operation and Task IDs until all acceptance evidence is recorded. Use the production Project deletion API for this Project when done; do not broadly delete Workspace data or infer orphaned R2 objects. Outstanding upload grants must expire before exact-key cleanup can be considered complete.
