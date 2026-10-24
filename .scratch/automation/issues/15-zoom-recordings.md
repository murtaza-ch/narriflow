# 15 - Zoom cloud recordings as an Autopilot source

**What to build:** A Workspace connects Zoom. When a cloud recording completes, a rule with Zoom as its source imports it with its Recipe.

**Blocked by:** [12 - Recipes](12-recipes.md).

**Status:** done

## Behavior

- Zoom OAuth (user-managed app) connection per Workspace member, stored like Social Account tokens (sealed, refreshed). Scopes: the minimum for `recording.completed` webhooks and recording download (check Zoom's current granular scopes).
- Webhook endpoint:
  - It handles Zoom's URL validation challenge and verifies the `x-zm-signature` HMAC with the app's secret token.
  - It deduplicates by event ID, and it answers quickly.
  - Work happens in a job.
- Autopilot rules gain a source kind (`rss` or `zoom`) with source-specific fields. A Zoom rule names the connected Zoom user and optional topic filters.
- On `recording.completed`, matching rules create an intake that downloads the MP4 (the shared screen with speaker view is preferred when present) using the stored token, under normal admission, usage, and Brand Profile rules. Dedupe is by Zoom meeting UUID plus recording ID, like Autopilot episodes.
- Env: `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, `ZOOM_WEBHOOK_SECRET_TOKEN`. Feature hidden without them.
- Runbook for creating the Zoom app and submitting it for review (owner step).

## Acceptance criteria

- [x] Signature verification and the validation challenge match Zoom's documented algorithm (unit tests with doc examples).
- [x] One recording imports once per rule even when Zoom retries (DB test).
- [x] Tokens never logged; revoked connection pauses its rules with a reason.
- [x] lint, typecheck, test, Autopilot gate pass on the local Postgres.

## Comments

2026-10-24: implemented on dev. User-managed Zoom OAuth is bound to the browser member, Workspace, and callback URI; state is hashed and consumed once. Tokens use AES-GCM with a Zoom-specific authentication context and the shared Social Account encryption key. The worker serializes refresh-token rotation. The public endpoint implements Zoom's URL challenge and raw-body HMAC with a five-minute timestamp tolerance, bounds body size, and stores only recording IDs and selected metadata. Durable, leased notification jobs retry capacity and quota refusals. Project, Ingest Job, Recipe snapshot, processing reservation, Workspace Event, and per-rule meeting UUID/recording ID dedup commit together. Workers resolve a fresh download URL, authenticate with the connected user's token, and run the normal media, admission, Brand Profile and generation handoff path. Disconnection, signed deauthorization, and rejected refresh credentials pause rules and covering grants; rule source edits pause grants, renames do not. Reconnecting does not resume rules automatically. There is no recording-library backfill.

Verified: repository lint passes with existing warnings; typecheck passes all 13 tasks; `bun run test` passes all 8 tasks, including 697 worker tests and 914 web tests. Local disposable-schema PostgreSQL gates pass: vizard-expansion/Autopilot/Zoom (65), integration-api, social-publication (110), workflow (154), processing-usage (21), and upload-session. Signature, challenge, API and HTTP-boundary tests pass. The production Autopilot component was checked in Chrome through a temporary fixture at desktop and 390px mobile widths, including conditional fields and the submitted connection, topic filter and Recipe. Next.js reported no compilation or runtime errors. The fixture was removed.

Owner rollout remains: configure a user-managed Zoom app and the shared credentials, apply the pending migration history including `20261024220000_zoom_autopilot`, deploy in the documented order, and run a live authorization/cloud-recording test. No credentials were requested or installed, no shared migration was applied, and nothing was pushed. Setup and Marketplace review steps: [Zoom runbook](../../../docs/runbooks/zoom-autopilot.md).
