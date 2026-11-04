# 04 Ingest and upload

**What to build:** Intake only accepts what can succeed, interrupted uploads recover, and valid files are not refused.

**Blocked by:** None

**Status:** done

Owns: `packages/services/src/upload-session.service.ts`, `source-readiness.ts`, `ingest-source-definition.ts`, `r2-storage.ts` upload parts, `apps/media/python/narriflow_media/{fetch,fetch_runtime,file_source_runtime,source_runtime}.py`, `apps/media/src/direct-source.ts`, `apps/web/app/(app)/upload/**`, `packages/validators/src/upload.ts`.

## Must fix
1. **Upload original never deleted after a successful pin (critical).** `upload-session.service.ts:3199`, `ingest-job-lifecycle.ts:450`, `media-cleanup-contract.ts:9`. `upload_source_pinning` is declared but never written, so every upload stores double and deletion promises are false. When an `upload_finalize` job completes, admit `{origin:"upload_source_pinning", cleanupClass:"upload_source", objectKey:<payload.storageKey>, projectId}` with `notBefore` past the longest PUT grant, in the same transaction. DB test.
2. **Nine of eleven advertised link providers can never succeed (high, verified).** `project.service.ts:1522`, `ingest-source-definition.ts:45`, `apps/media/python/narriflow_media/source_runtime.py:46`. Refuse non-direct, non-YouTube links at intake with `link_unsupported_source`, before credits are reserved. Remove them from hints and UI claims. Delete `extractor_source`. Check docs and landing copy for the same claims.
3. **Transient failure on first `open` bricks that file in that browser (high).** `apps/web/app/(app)/upload/_lib/upload-session-browser.ts:572-604`, `upload-session.service.ts:2038-2045`. When `existing.sessionId === null`, call `open` with the saved key. Test it.
4. **YouTube duration and live status checked only after paid download (high).** `apps/media/python/narriflow_media/fetch_runtime.py:116-152`, `fetch.py:177-202`. In `resolve`, refuse `is_live` and `live_status` in `{is_live,is_upcoming}`, and refuse duration over the cap. Put the plan's `maxSourceSeconds` in the command.
5. **Exact-minute sources permanently rejected (medium, measured).** `fetch.py:212`, `source-readiness.ts:12-13`. A 60.000s MP4 extracts to 60.011s audio, 1 vs 2 credits, `source_audio_video_mismatch`. Remove the credit-equality checks, keep the existing tolerance, debit from one fact with a small epsilon. Exactly 60:00 on the Free plan must not fail as a mismatch.
6. **Abandoned upload holds credits up to 24h (medium).** `apps/web/app/(app)/upload/_lib/upload-resume.ts:2,140-153`, `processing-usage.ts:352-359`, `upload-session.service.ts:116`. Before replacing a record with a `sessionId`, call `discard`. Key records by fingerprint.
7. **Any probe failure is retryable (medium).** `file_source_runtime.py:68`, `fetch_runtime.py:195-199`. Parse the coded stderr failure, pass permanent codes through, add a user-facing message.
8. **Single-PUT uploads show no progress (medium).** `upload-session-browser.ts:656-664`. Pass `onProgress` and publish `transferredBytes`.
9. **Browser accepts MIME types the server refuses (medium).** `upload-shell.tsx:618-625`, `upload-session-browser.ts:592`, `packages/validators/src/upload.ts:14-24`. Normalise by extension before `open` and refuse unsupported types locally. Put the extension-to-MIME map in validators and reuse it from `apps/web/.../upload-shell.tsx:91`, `apps/mcp/src/upload.ts:29`, and where the Python and `execution-transfer.ts:47` lists can follow.
10. **Free project can be expired when created (low).** `upload-session.service.ts:3683-3687`. Anchor retention to handoff.
11. **Retention computed outside the usage lock (medium, from billing review).** `project.service.ts:1655,1992`, `upload-session.service.ts:3684`. A paying customer's Project can get a Free deadline and be purged. Read `pricingTier` and assign retention inside the transaction after `lockWorkspaceUsage`.
12. **Completed multipart objects orphaned (low).** `upload-session.service.ts:2677-2688,3200`. Remove the `transferKind !== "single"` gate.
13. **Presigned PUTs do not bind size (low).** `r2-storage.ts:211-247,599-620`. Sign `Content-Length` if R2 enforces it; otherwise record that in Comments.
14. **Lifecycle guard never called (low).** `upload-session.service.ts:163`. Call it from `env:check` or delete it.
15. **Direct-read content-type allowlist may refuse valid files (plausible).** `apps/media/src/direct-source.ts:39`. Allow generic binary types and let ffprobe decide.

## Reuse
- Duplicate audio/video rules: `fetch.py:205`, `source-readiness.ts:5`. Keep the server as authority.
- `normalize_youtube_source` (`manifest.py:50`) duplicates `ingestYouTubeMediaId`; `isMissingMultipartUpload` (`upload-session.service.ts:4246`) duplicates `isExactMissingMultipartUploadError` (`r2-storage.ts:430`).
- `upload-session.service.ts` is 4,719 lines. Move Prisma persistence (3304-4244), the R2 adapter (4304-4426) and module wiring into `upload-session-runtime.ts`, per the AGENTS.md naming rule, as the last step and only if tests stay green.

## Verification
`test:upload-session:db`, `test:processing-usage:db`, Python tests per `apps/media` README.

## Comments

Implemented 2026-11-04. Every finding below was confirmed in the code unless marked otherwise.

**Fixed**
1. `finalizeVideoExecution` admits `upload_source_pinning` in the completing transaction, `notBefore` = `SINGLE_PUT_CLEANUP_DELAY_MS` (the existing late-write allowance, moved to validators, about 47h). Longer than the longest grant on purpose: a PUT started just before expiry can still land.
2. `LINK_PROVIDERS` is now YouTube, Dropbox and a host-less `gdrive` (label for Picker imports only). `strategy` and `extractor_source` deleted. `linkIngestSchema` no longer refines the host, so every caller gets the stable `link_unsupported_source` 422 from `queueLinkIngest`, before reservation. Also refused: YouTube pages that name no single video (channels, playlists), which passed intake and died at `ingestYouTubeMediaId`. Web hint, source icons, landing copy, docs and error message updated. OpenAPI and MCP text only say "supported link", so the OpenAPI document did not change.
3. A saved key with no `sessionId` calls `open`.
4. `maxSourceSeconds` added to the YouTube command. `resolve` refuses live and upcoming (`source_live_unsupported`, new, permanent, with message) and over-cap (`ingest_max_duration_exceeded`). yt-dlp's own "live event will begin" and "premieres in" errors map to the same code.
5. Measured with real ffmpeg through `source-audio-cli.ts` and `probe-cli.ts`: 60.000s to 60.011s, 3600.000s to 3600.022s. Credit equality removed from both sides; time tolerance kept. `SOURCE_DURATION_EPSILON_SECONDS = 0.25` lives in `pricing.ts`; `creditsForSourceSeconds` and the new `sourceExceedsLimit` use it, so 60.011s is 1 credit, 3600.022s is 60 and within the Free cap. Debit still comes from one fact (`settle`). Existing fixtures at 60.01s moved to 60.5s, and two mismatch fixtures to 61.5s.
6. Records are keyed by fingerprint, stored as one list. Starting a file discards other files' saved sessions before `open`, keeps the record on an outage, ends it on a refusal.
   **Deviation:** a record with `transferActiveAt` under 2 minutes old is skipped, so a second tab cannot discard a live upload in the first. Without this the fix would kill concurrent uploads on plans that allow them. Closing a tab mid-transfer and starting another file within 2 minutes leaves that hold until the next start.
7. `probe-cli.ts` now emits `errorCode` and `retryable`. `probe_failure` in `fetch.py` passes permanent codes through in both runtimes. `source_media_invalid` got a message and a permanent classification. Real garbage file test included.
8. Single PUT publishes bytes, speed and ETA through a reporter shared with multipart.
9. `uploadMimeTypeForFile` and `uploadMimeTypeByExtension` in validators; used by the adapter, upload shell, `FILE_ACCEPT` and `apps/mcp`. `execution-transfer.ts` spreads `uploadMimeTypes`. `.m4v` maps to `video/mp4`. Python's `source_sink.py` lists stay, since they cannot import TS.
10. and 11. Retention is assigned inside the transaction after the usage lock, on all three paths. Upload handoff now takes `lockWorkspaceUsage` and anchors the deadline to handoff; `Project.createdAt` is unchanged.
12. Gate removed, including for discard and expiry paths.
14. Guard deleted, with its test and export. Nothing set the variable, and `env:check` reads local files, so it could not see the bucket rule. The session hard lifetime is 6 days and R2's default multipart abort is 7, but that default was not verified against the bucket.
15. Generic binary types allowed; `text/html`, JSON and images still stop. A missing `Content-Type` still refuses.

**Reuse**
- `isMissingMultipartUpload` deleted for `isExactMissingMultipartUploadError`.
- `normalize_youtube_source` deleted, since production always passed a `YouTubeSource`. `ingestYouTubeMediaId` now wraps validators' `youtubeMediaId`.
- `verify_source_audio_binding` stays as an early stop before publishing; the server stays the authority. Removing it would upload a video only to refuse it.

**Skipped**
- 13. Not signed. R2's presigned URL docs mention only `Content-Type` as enforced, and proving `Content-Length` needs a real bucket, which rule 6 forbids. Finalize still verifies size by HEAD, so an oversized PUT cannot hand off.
- `upload-session.service.ts` split. Optional, and seven agents were editing around it. Isolated helper removals landed; the 4,600-line move should run alone.

**Tests that did not fail first:** item 12's test was written after the gate came out. For 3 and 8 the tests were confirmed red by mutating the fix back out. 6, 9 and 15 tests were written with the code.

**Verification** (local test database, `PGTZ=UTC`)
- `test:upload-session:db` 21 pass, `test:processing-usage:db` 35 pass.
- Execution gate: `targeted-ingest-execution` 31 pass; `source-audio-admission`, `upload-session-execution`, `ingest-job-lifecycle`, `ingest-handoff`, `generation-usage`, `targeted-workflow-execution` 52 pass, 5 pass in the separately fenced run.
- Python: 205 run, OK, 2 skipped. Fast suite: 1 failure, `pending-business-workspace.service.test.ts`, from ticket 02's new `outboundDeliveries` relation, not this ticket.
- Route inventory, `openapi:check`, `check:web-split` pass. Biome clean on touched files.

**Deploy note:** the YouTube command gained a required field and Python requires it, so the API and the media image must ship together.
