# 07 — Signed ElevenLabs webhook route with sized bodies

**What to build:** `POST /api/webhooks/elevenlabs` in the owning API domain (projects/transcripts domain or wherever STT belongs), admission `trust:"provider_signature"`, mounted with the other webhooks outside Clerk/workspace gating; signature per D4 using `ELEVENLABS_WEBHOOK_SECRET`; body limit per D5 (dedicated class, mutually exclusive with the 1 MiB webhook class, Bun native cap raised); parse success (`type:"speech_to_text_transcription"`, `data.request_id`, `data.webhook_metadata`, `data.transcription`) and error (`webhook_error`, top-level fields) envelopes; call `finalizeScribeTranscript` / failure entry; 2xx after durable handling, 5xx on temporary failure, 2xx no-op for stale/unknown. Update `test:inventory`, runtime composition, env example.

**Blocked by:** 02, 04

**Status:** ready-for-agent

**Acceptance:**
- [ ] Signature test matrix (D4), envelope tests, stale/duplicate no-op, >16 MiB Content-Length and chunked ingress test, other routes' limits unchanged.
- [ ] `bun run --cwd apps/api test`, `test:inventory`, `bun run check:web-split` green.
