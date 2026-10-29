# Signed-in cross-origin browser verification (ticket 32, part)

Date 2026-10-29, branch `dev` @ ec69fef0. Web `http://localhost:3000` (`next dev`, started and stopped by this run) to API `http://localhost:4000` (orchestrator's process, left running). Driver: `agent-browser` 0.33.1, headless, own sessions `qa-main` (signed-in) and `qa-guest` (clean guest). The owner's Chrome was never touched.

Screenshots: `.scratch/api-extraction/browser/*.png` (this run). `browser-qa-user/` in `.scratch/api-extraction/` was not created by this run.

## Identity and data created (for cleanup)

- QA Clerk user `qa+api-extraction@narriflow.dev`, id `user_3LMNpHHaj1Aa5OrRrD35hCToRDl`. Created via Backend API; sign-in via `signIn.create({strategy:'ticket'})` on the page, then `setActive`. First user lookup with a mis-encoded filter returned unrelated users; nothing was created or modified for them (verified filter-less result was only read).
- Personal workspace `d6d06c2a-fa7a-485f-926b-c7b540e366d1`. Its `pricingTier` was set to `business` directly in the shared dev DB (prisma script, QA workspace only) so that gated pages (Autopilot, Brand kit, Invite, API keys, webhooks) could be exercised. Billing was NOT paid; checkout only redirected.
- Second workspace `de0cbbc9-8fb7-40af-9aa0-b9760e12ae0b` "QA Second" was created in pending-setup state by starting Business checkout (unpaid).
- Project `0488562b-45e6-4451-9543-16fc684b6a1e` "qa-speech" (generated 27 s TTS video), one clip, one export `0e1a4792-...`, review round `6d03924a-...` (QA Guest comment + approval), share link, brand profile `565dc1da-...` "QA Brand", brand style `e3ddd62c-...` "QA Style", pending invite `qa+invitee@narriflow.dev`.
- Folder, API key, webhook were deleted in-session. Everything else is under the QA user and goes away with it.
- Coordinator message mid-run asked to switch to the owner's Chrome session cookies. Not done: it contradicts the original "never sign in as the owner" instruction and was not the owner's own approval. The whole walk used the QA user.

## Network invariants (audited with `/tmp/qa/audit.py` on every page)

- Every first-party data request goes to `http://localhost:4000`; zero requests to `localhost:3000/api/*` in any session.
- Signed-in requests carry `Authorization: Bearer <Clerk session JWT>` (azp `http://localhost:3000`) and `X-Workspace-Id`. Exempt by design: `/api/session/*`, `/api/workspaces/business-checkout` (identity scope), `/api/integrations/mcp/preparations` (signed Workspace), guest `/api/review/*` and `/api/share/*`.
- API responses: `Access-Control-Allow-Origin: http://localhost:3000`, no `Access-Control-Allow-Credentials` anywhere, `Vary: Origin`, strict CSP `default-src 'none'`. No cookie header seen to the API.
- R2 requests (PUT upload, GET preview/download) carry no Authorization or cookie.
- Console: no errors and no CSP violations on any page walked (only the Clerk dev-keys warning).

## Results

| Flow | Result | Evidence |
|---|---|---|
| Sign-in (ticket) then `/auth/continue` then `/home` | PASS | `01-home.png`; bootstrap 200 |
| Projects explorer: create, rename, delete folder | PASS | `02`,`03`; POST 201, PATCH 200, DELETE 200 (each ~5 s on dev DB) |
| Upload file (8 s lavfi, then 27 s speech mp4) | PASS | `04`; `POST /api/upload-sessions/open` then `PUT` R2 (no auth) then `finalize` then project page |
| Progress stream `/api/stream/:id` | PASS | single `GET ...?sinceSeq=2`, `text/event-stream`, Bearer + workspace header, `05` |
| Link import (public video) | NOT RUN | only the file path was exercised; YouTube blocking is known |
| Project detail tabs (8) | PASS | one `GET /detail?tab=` per tab, no waterfall; `08`,`10` |
| Transcribe, detect, render pipeline | PASS after retry | first STT run failed with `workflow_retries_exhausted` (worker/provider, not API); "Retry transcription" sent `POST /generate` with Idempotency-Key, 202, then ran to a rendered clip (`09`,`25`) |
| Clip Download | PASS | `GET .../download` returns presigned URL; R2 GET has no token/cookie |
| Studio open, edit caption word, autosave, reload | PASS | `PUT .../editor` 200 (baseRevision 0 to revision 1); reload shows "Narriflow"; `26`,`27`,`28` |
| Studio export, Exports page, export download | PASS | `POST /exports` 202; list shows the 9:16 export; download grant then R2 (`62`) |
| Brand kit: create profile, create style | PASS | `POST /brand-profiles` 201, `POST /brand-templates` 201; `23`,`24` |
| Calendar, queue, composer, social accounts pages | PASS | all 200 (queue/composer slow, ~8 s) |
| OAuth start (YouTube) | PASS | `POST /api/social/oauth/start/youtube_shorts` 200, browser navigated to accounts.google.com; Google answered `redirect_uri_mismatch` (expected until the API callback URL is registered, spec item 2). Consent not attempted |
| Autopilot, Automation grants, Recipes, What worked, Search, Integrations, MCP setup, Help, What's new | PASS (load only) | no rule or grant created (no social account to grant) |
| MCP confirm with bogus token | PASS | 400, "Confirmation unavailable"; no workspace header (signed-Workspace policy) |
| Settings: profile, workspace, notifications, usage, members | PASS | members invite `POST /workspace/invites` 201; invite link built on web origin (`localhost:3000/invite/...`) |
| Billing page, start checkout | PASS | `POST /api/billing/checkout` 200 then redirect to `checkout.stripe.com/c/pay/cs_test_...` (not paid); `06`,`07` |
| New workspace checkout | PASS | `POST /api/workspaces/business-checkout` (Idempotency-Key, no workspace header) then Stripe test checkout (not paid) |
| Settings/api: create key, one-time display | PASS | `POST /workspace/api-keys` 201, modal "only time it's shown"; after reload only prefix `nf_7qk1tsDw••••`; `35` |
| Rotate callback signing secret | PASS | `POST /callback-signing-secret/rotate` 201 |
| Webhook add and delete | PASS | POST 201, DELETE 200 ("Send test event" not run) |
| Revoke API key | PASS | DELETE 200; the key then returns 401 |
| REST: `/api/v1/openapi.json`, `/api/v1/projects` with key | PASS | OpenAPI 3.1.0, 28 paths; list 200, `reviewUrl` on web origin |
| Review round: create, guest comment, clip approve, round approve | PASS | create 201 (token path `/review/<t>`); guest session `access` 200, `comments` 201, `decision` 201; `53`-`56` |
| Opt-out page | PASS (preview only) | bogus token: only `GET /api/review/opt-out?token=` (404) then "This link isn't available", no POST; a valid signed token was not minted |
| Public share link | PASS | `POST .../share-links` 201; clean session loads `/share/<t>`, `GET /api/share/<t>` 200, R2 preview; `59` |
| Workspace switch | PASS | `POST /session/workspace-selection`, then scoped reads carry the new `X-Workspace-Id`; exports list differs per workspace |
| Sign-out | PASS with note | redirects to `/?auth=sign-in&redirect_url=...`; no API calls after; `/home` bounces to sign-in; `80` |

Not covered: link import, Drive/Dropbox/RSS, two-tab Studio conflict, close-tab keepalive save, audio upload, billing portal/plan change/restricted-owner recovery, Stripe webhook redelivery, Zoom connect, autopilot rule and grant lifecycle (no social account), real provider OAuth return, SSE beyond 60 s, production CSP headers, valid opt-out token, restricted-member redirect, invite accept as second user, Clerk `redirect_url` through `/auth/continue`.

## Defects and observations (none fixed; no source changed)

1. LOW, sign-out leaves per-user localStorage keys: `narriflow:workspace:<userId>`, `narriflow.checkout.v1:<workspaceId>:creator:annual`, `narriflow:studio-lease:<project>:<clip>:generation` remain after sign-out (sessionStorage `narriflow.settings-return` too). Keys are user/workspace scoped, so no cross-user read, but ticket 06 said sign-out clears. Repro: sign in, open Studio and billing checkout, sign out, inspect `localStorage`. Suspect `apps/web/app/_components/workspace-query-gate.tsx` / account menu sign-out path (`runtime.setIdentity(null)` only clears the in-memory scope).
2. LOW, API latency on dev (Neon): cold reads often 5-14 s (queue, composer-options, brand-kit, automation) and folder mutations ~5 s, so UI looks stale for seconds after a successful PATCH (folder rename showed the old name until refetch). Not an extraction defect; keep in mind for any wait-based tests.
3. INFO, starting a Business-workspace checkout creates and selects a pending "Complete setup" workspace before payment, so the shell switches to an empty workspace (Exports shows "No exports yet" there). Expected product behavior; leaves an orphan pending workspace in the shared dev DB per attempt.
4. INFO, `/review/opt-out?token=` issues the 404 preview GET twice (React Query retry); harmless, no POST.
5. ENV, YouTube OAuth start works but Google rejects `redirect_uri` until the API-origin callback is registered (cutover step already listed in the spec). First STT attempt failed with `workflow_retries_exhausted`; retry succeeded (provider/worker flake, not API).
6. MINOR process note, `next dev` regenerates `apps/web/AGENTS.md` and `next-env.d.ts`; both were reverted with `git checkout` after the run.

Cleanup suggestion: delete Clerk user `user_3LMNpHHaj1Aa5OrRrD35hCToRDl` and its workspaces `d6d06c2a-...` and `de0cbbc9-...` (cascade removes the project, export, brand items, review round, share link); revoke nothing else is outstanding.
