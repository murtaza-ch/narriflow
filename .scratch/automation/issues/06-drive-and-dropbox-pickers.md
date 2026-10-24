# 06 - Google Drive Picker and Dropbox Chooser

**What to build:** On the upload page, people can choose a recording from Google Drive or Dropbox instead of uploading it from their computer. The file goes from the provider straight to Narriflow's servers.

**Blocked by:** None.

**Status:** done

**Map:** [Automation and integrations map](../map.md), Drive Picker and Dropbox Chooser verdict.

## Behavior

- Dropbox: load the Dropbox Chooser with `NEXT_PUBLIC_DROPBOX_APP_KEY`, `linkType: "preview"`, video extensions only, single file. The result is a `dropbox.com` shared link that link intake already supports (`packages/validators/src/link-providers.ts`). Submit it through the existing link intake. No server change unless the existing provider can't fetch Chooser links; verify with the provider definition.
- Google Drive: Google Identity Services token client with only the `drive.file` scope (non-sensitive, no CASA), plus the Google Picker with `NEXT_PUBLIC_GOOGLE_API_KEY`, `NEXT_PUBLIC_GOOGLE_CLIENT_ID`, and `NEXT_PUBLIC_GOOGLE_APP_ID`. The Picker grants the app access to the chosen file only. The browser sends `{ fileId, accessToken }` to a new intake variant:
  - The server checks the file's metadata with the Drive API (name, size, video MIME type, duration if present) under the existing admission and usage rules.
  - It seals the token with the existing cipher pattern (HKDF of `SOCIAL_TOKEN_ENCRYPTION_KEY`, as Completion Callback URLs are sealed).
  - It queues an Ingest Job that downloads `files/{id}?alt=media` through `guardedFetch` with the token, deletes the sealed token when the download ends or fails, and fails with "Choose the file again" if the token has expired.
  - It never stores the token beyond the job.
- Brand Profile and generation settings follow the same rules as link intake.
- Both buttons appear only when their env vars are set. Document the env vars in `README.md` and add a runbook section for creating the Google Cloud and Dropbox apps.
- Follow the upload page's existing design.

## Acceptance criteria

- [x] Dropbox choice becomes a normal link intake.
- [x] Drive choice creates a Project and Ingest Job; the worker downloads with the token and discards it; an expired token fails with the actionable message (unit and DB tests with a mocked Drive API).
- [x] Tokens never appear in logs, errors, or API responses.
- [x] Buttons hidden without configuration.
- [x] `bun run lint`, `bun run typecheck`, `bun run test`, and the upload or ingest DB gate pass on the local Postgres.

## Comments

2026-10-24: implemented in a worktree, Opus-reviewed (two medium findings fixed: recovery follows the job source, Drive 403 rate limits retry), merged into the main checkout with ticket 01. Verified there: biome, typecheck, `bun run test`, and the workflow, processing-usage, upload-session, integration-api, brand-profiles, and vizard-expansion DB gates on the local Postgres. Not tried against real Google or Dropbox apps; the `tokeninfo` POST for access tokens needs a live check. Migration `20261024120000_drive_picker_intake` must reach the shared database before deploy, workers first.
