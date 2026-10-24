# 15 - Zoom cloud recordings as an Autopilot source

**What to build:** A Workspace connects Zoom. When a cloud recording completes, a rule with Zoom as its source imports it with its Recipe.

**Blocked by:** [12 - Recipes](12-recipes.md).

**Status:** ready-for-agent

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

- [ ] Signature verification and the validation challenge match Zoom's documented algorithm (unit tests with doc examples).
- [ ] One recording imports once per rule even when Zoom retries (DB test).
- [ ] Tokens never logged; revoked connection pauses its rules with a reason.
- [ ] lint, typecheck, test, Autopilot gate pass on the local Postgres.
