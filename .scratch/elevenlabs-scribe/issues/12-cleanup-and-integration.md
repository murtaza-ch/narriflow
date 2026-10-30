# 12 — Remove AssemblyAI residue, integrate, verify, deploy checklist

**What to build:** Remove every remaining AssemblyAI reference (README, env examples, `scripts/env-check.ts` prefix → `ELEVENLABS_`, error copy, comments, tests, fixtures); env docs for `ELEVENLABS_API_KEY`, `ELEVENLABS_WEBHOOK_ID` (worker) and `ELEVENLABS_WEBHOOK_SECRET` (API); runbook section for the webhook (URL, HMAC, retries on); drain/reset pending AssemblyAI waiting runs on shared dev; full verification suite from the spec; Railway variables set; deploy and live end-to-end webhook test.

**Blocked by:** 03, 06, 07, 10, 11

**Status:** code-done (deploy, Railway vars, shared-dev drain, live webhook test remain with the orchestrator)


## Comments

- Code/docs cleanup done: AssemblyAI references removed from comments, fixtures and README (kept: ADR 0018 and the language-migration test, both about historical rows). README transcription sections, runbook "ElevenLabs Scribe webhook" section, api `.env.example` note rewritten. `subtitle-lines.ts` paragraph edits now split no-space scripts per character and rejoin with `joinTranscriptWords` (zh/ja tests added).
- Verification: lint, typecheck, test (only the 3 known `ingest.test.ts` upload-pinning failures), test:inventory, openapi:check, check:web-split (+ `--bundle` after build), and DB gates workflow 220, processing-usage 31, upload-session 15, integration-api 7, clip-editor-persistence 7+3 all pass on local Postgres 17. `env:check` cannot run in a worktree (no env files). Web build needs a Clerk publishable key as well as `NEXT_PUBLIC_API_URL`.
