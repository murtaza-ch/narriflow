# 02 — Durable, fenced provider submission in the workflow lifecycle

**What to build:** Lifecycle + schema support for spec D1/D2 in `packages/services/src/workflow-run-lifecycle.ts` (+ Prisma if fields are needed; this ticket is the sole `schema.prisma` owner).
- `beginProviderSubmission(attempt, {deadline})`: run → `waiting` with `providerJobId` null before the POST.
- `recordProviderAcceptance(attempt, {requestId, transcriptionId})`: tolerant of terminal/cancelled attempts, never resurrects; stores request id separately (new nullable column, e.g. `Transcript.providerRequestId`).
- `claimDueWaitingTranscripts` also claims waiting runs with null provider id so their deadline can fail them (retryable `elevenlabs_submission_unconfirmed`).
- Completion entry usable by the API callback: complete/fail a waiting run by `(workflowRunId, attemptId)` (+ optional provider ids) with stale/duplicate/terminal → no-op result. Do not loosen `ownedAttemptWhere` globally.
- Replace provider stamps `"assemblyai"`/model chain with `"elevenlabs"`/`scribe_v2` in `project.service.ts`, `ingest-job-lifecycle.ts`, `workflow-run-lifecycle.ts`.
- Retry policy codes renamed per D13 in `processing-retry-policy.ts` (+ test).

**Blocked by:** 01

**Status:** done

**Acceptance:**
- [x] DB tests (`bun run test:workflow:db`): callback-before-acceptance, crash-before-ID-save → deadline fail → new attempt, duplicate success, stale attempt, cancelled run, error event, acceptance after terminal.
- [x] `bun run test:processing-usage:db` green; no new debit on retry/recovery.
- [x] Migration created with `prisma migrate dev --create-only` style SQL, not applied to shared DB.

## Comments

- Local Postgres 17 (port 55432, throwaway). `bun run test:workflow:db`: 220 pass, 0 fail (13 new in "durable provider submission": begin, acceptance idempotent/mismatch, callback-before-acceptance, duplicate success, crash-before-ID-save → deadline fail → attempt 2, not-due/accepted-meanwhile, exhausted budget, stale attempt, cancelled run, error event, acceptance after terminal, lookup/not_waiting). `bun run test:processing-usage:db`: 31 pass. Typecheck, biome, `bun test packages/services` green. Nothing run against Neon.
- Migration `20261030170000_transcript_provider_submission` adds `Transcript.providerRequestId` and `Transcript.providerSubmissionDeadlineAt` (additive, nullable). Not applied to the shared database.
- `waitForProvider` is kept only because the AssemblyAI worker still calls it; ticket 06 deletes it. `transcribe.ts` has one interim guard line (skips claimed runs with a null provider id).
- `error-messages.ts` (validators) still carries `assemblyai_*` copy keys; the retry policy now lists the `elevenlabs_*` permanent codes. Ticket 06/12 owns the copy rename.

### Sol branch review fixes (findings 1, 2, 4, 5)

- 1: an indeterminate POST (timeout, network error, unreadable 2xx) throws `ScribeSubmissionUnconfirmed`; `processTranscriptRun` leaves the run `waiting` on its attempt. Callback finalizes it; `expireUnconfirmedProviderSubmission` settles it after the deadline. Definite HTTP rejections still fail at once.
- 2: finalization persistence errors keep the run waiting until the result deadline, then fail through `failProviderAttempt` (retryable `elevenlabs_transcript_fetch_failed`); the results batch logs and continues past any per-run error.
- 4: `completeProviderTranscript` merges recorded ids under the row lock; the finalizer defaults omitted ids to the looked-up ones.
- 5: classifier moved to `packages/services/src/scribe-errors.ts` (`scribeHttpFailure`, `scribeErrorDetail`, new `scribeCallbackFailure`); the webhook route classifies `error_message`. Added user copy for `elevenlabs_transcription_failed`.
- Evidence: worker transcribe tests 58 pass; services scribe tests 56 pass; api webhooks 25 pass; `test:workflow:db` 222 pass on local Postgres 17 (port 55441); typecheck green; lint has only pre-existing web CSS warnings.
