# 02 — Durable, fenced provider submission in the workflow lifecycle

**What to build:** Lifecycle + schema support for spec D1/D2 in `packages/services/src/workflow-run-lifecycle.ts` (+ Prisma if fields are needed; this ticket is the sole `schema.prisma` owner).
- `beginProviderSubmission(attempt, {deadline})`: run → `waiting` with `providerJobId` null before the POST.
- `recordProviderAcceptance(attempt, {requestId, transcriptionId})`: tolerant of terminal/cancelled attempts, never resurrects; stores request id separately (new nullable column, e.g. `Transcript.providerRequestId`).
- `claimDueWaitingTranscripts` also claims waiting runs with null provider id so their deadline can fail them (retryable `elevenlabs_submission_unconfirmed`).
- Completion entry usable by the API callback: complete/fail a waiting run by `(workflowRunId, attemptId)` (+ optional provider ids) with stale/duplicate/terminal → no-op result. Do not loosen `ownedAttemptWhere` globally.
- Replace provider stamps `"assemblyai"`/model chain with `"elevenlabs"`/`scribe_v2` in `project.service.ts`, `ingest-job-lifecycle.ts`, `workflow-run-lifecycle.ts`.
- Retry policy codes renamed per D13 in `processing-retry-policy.ts` (+ test).

**Blocked by:** 01

**Status:** ready-for-agent

**Acceptance:**
- [ ] DB tests (`bun run test:workflow:db`): callback-before-acceptance, crash-before-ID-save → deadline fail → new attempt, duplicate success, stale attempt, cancelled run, error event, acceptance after terminal.
- [ ] `bun run test:processing-usage:db` green; no new debit on retry/recovery.
- [ ] Migration created with `prisma migrate dev --create-only` style SQL, not applied to shared DB.
