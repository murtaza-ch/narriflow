# 06 — Replace the worker transcription adapter

**What to build:** Rewrite `apps/worker/src/tasks/transcribe.ts` around Scribe (delete all AssemblyAI HTTP code): read `ELEVENLABS_API_KEY`/`ELEVENLABS_WEBHOOK_ID`; requested language → `language_code`, else probe (ticket 05) → pinned or unpinned; `beginProviderSubmission` → POST `/v1/speech-to-text` (multipart fields: `model_id=scribe_v2`, `diarize=true`, `timestamps_granularity=word`, `tag_audio_events=false`, `webhook=true`, `webhook_id`, `webhook_metadata={workflowRunId, attemptId}`, `source_url`=presigned R2 source with a lifetime ≥ deadline, or extracted mono audio `file` streamed when presigning is unavailable or the source exceeds the conservative URL size policy) → `recordProviderAcceptance`. `stt_results` loop: GET `/v1/speech-to-text/transcripts/{transcription_id}`; `404 transcript_not_found` = pending until deadline; 200 → `finalizeScribeTranscript`; error classification D13. Remote-fetch rejection after 202 (webhook_error / deadline) → next attempt uses extracted audio once. Rename env vars/constants; keep skip paths (supplied captions, no audio).

**Blocked by:** 02, 04, 05

**Status:** ready-for-agent

**Acceptance:**
- [ ] `transcribe.test.ts` rewritten: submit fields, 202 parsing, 404 pending, 200 finalize, 401/403/429/5xx dispositions, probe pin/unpin wiring, no-ID deadline.
- [ ] Live local run on the Urdu project with Auto and with `ur` (record outcome).
