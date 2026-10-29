# Zoom cloud recordings

An Autopilot rule can watch a connected member's Zoom cloud recordings. When Zoom finishes a recording, Narriflow imports one completed MP4, preferring shared screen with speaker view, and applies the rule's Recipe. Topic filters match a case-insensitive substring. Rules watch future recording completion events; there is no recording-library backfill or polling of Zoom.

## Configure the application

The Workspace owner creates a **General App** in the [Zoom App Marketplace](https://marketplace.zoom.us/develop/create), with user-managed OAuth. Use a development app while testing. Enable cloud recording for the Zoom user and record the meeting to the cloud.

Configure these values in both the API and worker environments:

| Variable | Value |
| --- | --- |
| `ZOOM_CLIENT_ID` | The app's OAuth client ID |
| `ZOOM_CLIENT_SECRET` | The app's OAuth client secret |
| `ZOOM_WEBHOOK_SECRET_TOKEN` | The app's event subscription secret token |
| `SOCIAL_TOKEN_ENCRYPTION_KEY` | The same existing encryption key on the API and worker |

The Zoom controls stay hidden until all four values exist. Keep real values in app-local environment files or the deployment's secret settings. `API_ORIGIN` determines the callback origin: Zoom reaches the API, never the web app. Local and deployed development apps share the database and queues, so every worker that can claim Zoom work needs the same credentials and encryption key.

Add the exact OAuth redirect URI and allow-list entry:

```text
https://<api-host>/api/zoom/oauth/callback
```

Use these granular **user** scopes:

| Scope | Used for |
| --- | --- |
| `cloud_recording:read:recording` | `recording.completed` notifications |
| `cloud_recording:read:list_recording_files` | Resolve the selected file's current download URL for each ingest attempt |
| `user:read:user` | Bind OAuth authorization to the Zoom host and account returned by `/users/me` |

Admin scopes, recording write/delete access, transcript access, and meeting access are not required. Zoom documents the event scope in [webhooks](https://developers.zoom.us/docs/api/webhooks/) and the recording retrieval scope and bearer download in [Get meeting recordings](https://developers.zoom.us/docs/api/meetings/#operation/recordingGet). The [OAuth guide](https://developers.zoom.us/docs/integrations/oauth/) describes authorization, refresh and revocation.

Enable event subscriptions for `recording.completed` and set the notification endpoint to:

```text
https://<api-host>/api/webhooks/zoom
```

Click **Validate** in Zoom. Narriflow answers the URL challenge by hashing `plainToken` with the webhook secret. Recording notifications require Zoom's `x-zm-signature` and `x-zm-request-timestamp` headers, with a five-minute timestamp tolerance. The body is capped at 1 MiB. Configure the app's deauthorization notification endpoint to this same URL. It accepts signed `app_deauthorized` events. Zoom sends deauthorization notifications for public apps; development/private apps need the in-app Disconnect button or detection of revoked credentials during download.

The endpoint persists a reduced notification and returns immediately. Downloading, minute reservation, Brand Profile checks, and Project creation happen in worker jobs. Original download URLs, download tokens and passwords are discarded. OAuth tokens are sealed with AES-GCM. Only the worker's in-memory download request uses a bearer token. Completed notification records expire after 30 days; per-rule recording deduplication survives Project deletion.

## Verify before enabling for users

1. Apply `20261024220000_zoom_autopilot` after its preceding migrations. Generate Prisma, deploy workers with the configuration, then deploy the API. Follow the [environment runbook](environments.md) for the shared database and coordinated rollout.
2. In Autopilot, click **Connect Zoom** and authorize the test user. Create a Zoom rule, choose that connection and a Recipe, and optionally enter a topic substring.
3. Finish a short cloud recording with a matching topic. Confirm that one Project appears, its source is Zoom, its Recipe settings and Brand Profile are frozen, and ingest produces clips through the existing generation handoff.
4. Use Zoom's webhook testing tools to resend the same notification. Confirm that each matching rule has one Project for the meeting UUID and selected recording ID. Multiple matching rules intentionally create their own Projects.
5. Confirm that an unrelated topic and a different host do not import. Disconnect Zoom and confirm its rules pause with a reconnect instruction. Reconnecting retains paused rules; resume them explicitly.
6. Check the notification job's `status`, `availableAt`, `attempts`, and fixed `lastError` code when imports are deferred. Capacity and quota refusals leave the recording unconsumed and retry with backoff. Brand Profile and acting-member failures pause the rule and retain pending work until it is fixed. A manually paused rule does not import recordings while paused.

Automated checks run with no Zoom account:

```sh
bun test packages/services/src/zoom.test.ts
bun run test:vizard-expansion:db
bun run lint
bun run typecheck
bun run test
```

The PostgreSQL gate needs a disposable local PostgreSQL instance with pgvector, because it applies the complete migration history. Set `DIRECT_URL` and `DATABASE_URL` for that local instance when running it. Never point a worker at this disposable test schema.

## Marketplace submission, owner task

For use outside the development app's allowed testers, follow Zoom's current [distribution options](https://developers.zoom.us/docs/distribute/) and [submission requirements](https://developers.zoom.us/docs/distribute/app-submission/). Provide the app description, privacy policy, support and documentation URLs, removal instructions, and a test account and recording of the connection-to-clips workflow requested by Zoom. Explain each scope using the table above. Verify notification validation and removal behavior on the deployed HTTPS host before submitting. Review approval and any account administrator pre-approval remain owner steps.

This code change does not register or publish a Marketplace app. Record the live OAuth and cloud-recording test here when credentials and an approved test app are available.

## 2026-10-29: Zoom reaches the API

Zoom's OAuth redirect URI and event subscription URL are API-origin endpoints (`${API_ORIGIN}/api/zoom/oauth/callback`, `${API_ORIGIN}/api/webhooks/zoom`). Starting the connection is a signed-in POST that returns the Zoom authorization URL; the callback identifies the person from the stored one-use state row, not from a session, because Zoom's redirect carries no Bearer token. Zoom is unregistered in current development, so nothing needs updating in a dashboard until the app is created.
