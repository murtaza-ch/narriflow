# 12 — Remove AssemblyAI residue, integrate, verify, deploy checklist

**What to build:** Remove every remaining AssemblyAI reference (README, env examples, `scripts/env-check.ts` prefix → `ELEVENLABS_`, error copy, comments, tests, fixtures); env docs for `ELEVENLABS_API_KEY`, `ELEVENLABS_WEBHOOK_ID` (worker) and `ELEVENLABS_WEBHOOK_SECRET` (API); runbook section for the webhook (URL, HMAC, retries on); drain/reset pending AssemblyAI waiting runs on shared dev; full verification suite from the spec; Railway variables set; deploy and live end-to-end webhook test.

**Blocked by:** 03, 06, 07, 10, 11

**Status:** ready-for-agent
