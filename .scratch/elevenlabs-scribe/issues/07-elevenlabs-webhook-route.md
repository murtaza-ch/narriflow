# 07 — Signed ElevenLabs webhook route with sized bodies

**What to build:** `POST /api/webhooks/elevenlabs` in the owning API domain (projects/transcripts domain or wherever STT belongs), admission `trust:"provider_signature"`, mounted with the other webhooks outside Clerk/workspace gating; signature per D4 using `ELEVENLABS_WEBHOOK_SECRET`; body limit per D5 (dedicated class, mutually exclusive with the 1 MiB webhook class, Bun native cap raised); parse success (`type:"speech_to_text_transcription"`, `data.request_id`, `data.webhook_metadata`, `data.transcription`) and error (`webhook_error`, top-level fields) envelopes; call `finalizeScribeTranscript` / failure entry; 2xx after durable handling, 5xx on temporary failure, 2xx no-op for stale/unknown. Update `test:inventory`, runtime composition, env example.

**Blocked by:** 02, 04

**Status:** done

**Acceptance:**
- [x] Signature test matrix (D4), envelope tests, stale/duplicate no-op, >16 MiB Content-Length and chunked ingress test, other routes' limits unchanged.
- [x] `bun run --cwd apps/api test`, `test:inventory`, `bun run check:web-split` green.

## Comments

- Route `POST /api/webhooks/elevenlabs` in the **projects** domain (`apps/api/src/domains/projects/{webhooks,elevenlabs-signature,runtime,admission}.ts`): the domain already owns transcript reads and workflow runs, and the route settles a project's transcript. Mounted in `app.ts` with the other webhooks, `trust: "provider_signature"`.
- Body limit: new `providerResult` class (128 MiB) in `BODY_LIMIT_BYTES`. The route declares `bodyClass("providerResult")`; the webhook mount now uses `routeBodyLimit("webhook")`, which picks exactly one limiter by marker (mutually exclusive by construction). Bun's native cap = 128 MiB; `ingressCeiling()` (app-wide, first) keeps every other route at the previous 16 MiB (`ORDINARY_BODY_CAP_BYTES`) on a declared Content-Length, covering MCP which has no limiter of its own.
- SDK check (elevenlabs-js `src/wrapper/webhooks.ts`): HMAC-SHA256 hex over `${t}.${rawBody}`, 30 min age window, compares `v0=<hex>`. Differences, all stricter and deliberate: no future bound in the SDK (we add 5 min), t is not validated as an integer there, compare is a plain `!==` (we use `timingSafeEqual`), SDK returns 400 (we return 401). Hashing is done over raw bytes (equal to the SDK's string form for valid UTF-8).
- Tests: `elevenlabs-signature.test.ts` (matrix), `webhooks.test.ts` (envelopes, duplicate/stale/terminal, metadata, 500), `webhook-ingress.test.ts` (real Bun.serve: 20 MiB Content-Length and chunked accepted, >128 MiB refused, other webhooks >1 MiB refused, >16 MiB refused on first-party/REST/MCP).
- Env: `ELEVENLABS_WEBHOOK_SECRET` required at API startup (`requireSetting`, like Clerk's), documented in `apps/api/.env.example` and README.
