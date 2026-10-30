# Final production-readiness round (owner, 2026-10-30)

Owner: "Do the final round, involve Sol to review everything, check everything
and make sure it's production ready."

What exists now (deployed from GitHub `dev` at b10e36ea; local-only commits
1cbd43e5 webhook-test fix, 4e6f8dc3 ElevenLabs skills):
- API extraction: standalone Hono API (`apps/api`, Railway
  https://narriflowapi-dev.up.railway.app), web is a client (`apps/web`, Vercel
  https://narriflow-dev.vercel.app), typed `packages/api-client`, React Query.
  Specs/tickets: `.scratch/api-extraction/`; cutover log there.
- Render hardening (21 tickets): `.scratch/render-hardening/` (spec, tickets,
  parity harness `apps/worker/scripts/render-golden.ts`, runbook
  `docs/runbooks/render-hardening.md`).
- Follow-ups: `.scratch/followups-2026-10-30/` (caption diagnostics, folder 409,
  permission notice, emoji motion, DV5 copy, audio gaps, pending Business
  checkout cleanup; Stripe now sends checkout.session.expired).
Critical paths and verification commands: `AGENTS.md`.

Ground rules for reviewers: read-only (no source edits, no commits), never kill
processes you didn't start, DB checks only via `.scratch/api-extraction/db-gate.sh`
(never the shared Neon DB for tests), report findings with severity
(P0 = data loss/security/money/outage; P1 = user-facing broken flow or wrong
output; P2 = degraded/edge; P3 = polish), file:line, concrete failure scenario,
and a fix. Prefer evidence (a failing test, a reproduction, a log line) over
speculation. Note what you verified as solid too.
