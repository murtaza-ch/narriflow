# Cloud file pickers

The upload page can import a recording straight from Google Drive or Dropbox.
Each picker appears only when its environment values are set on the web app, so
a deployment can offer one, both, or neither.

| Picker | Variables (web) | Also needed |
| --- | --- | --- |
| Google Drive | `NEXT_PUBLIC_GOOGLE_API_KEY`, `NEXT_PUBLIC_GOOGLE_CLIENT_ID`, `NEXT_PUBLIC_GOOGLE_APP_ID` (all three) | `SOCIAL_TOKEN_ENCRYPTION_KEY` in web **and** worker, identical |
| Dropbox | `NEXT_PUBLIC_DROPBOX_APP_KEY` | Nothing |

All four are public values. They reach the browser, so never put a client
secret in them. Changing one needs a web redeploy, not a worker deploy.

## Rollout order

Local and Railway workers share one queue, and any worker can claim a
`drive_import` job created by any web app. Release in this order:

1. Apply the `20261024120000_drive_picker_intake` migration to the shared database.
2. Deploy **every** worker (local, Railway) with the new code. A worker on an old
   Prisma client can fail to decode the `drive_import` job type, and would fail or
   stall the shared queue instead of leaving the job for a new worker.
3. Only then deploy a web build that shows the Drive button, by setting the three
   Google variables on web. Dropbox needs no migration or worker change.

To roll back, remove the three Google variables from web (the button disappears),
then let queued Drive jobs finish or fail before reverting workers.

## How each import works

**Dropbox.** The Chooser returns a `dropbox.com` shared link (`linkType:
"preview"`, one video). It enters the normal link intake as a Dropbox link, so
the worker downloads it like any pasted Dropbox link. Nothing is stored.

**Google Drive.** The browser asks for the `drive.file` scope only, then opens
the Google Picker. That scope reaches just the file the person picks. It is a
non-sensitive scope, so the app needs no restricted-scope verification or CASA
assessment. The browser sends the file ID and its short-lived access token to
Narriflow. The server then:

1. Checks the token with Google's `tokeninfo` endpoint (the token goes in a POST
   body, never a URL): it must have been issued to this app's client
   (`aud` equals `NEXT_PUBLIC_GOOGLE_CLIENT_ID`, read by the web server at run
   time) and carry `drive.file`. Otherwise it is refused, so a token minted for
   another app can't make the server fetch files.
2. Reads the file's name, size, type and duration from Drive, and refuses
   anything that is not a downloadable video within the size limit.
3. Admits it under the same minutes, capacity and per-video rules as a link.
4. Seals the token (AES-256-GCM, key derived from `SOCIAL_TOKEN_ENCRYPTION_KEY`
   with a Drive-specific HKDF label) in `IngestJob.sourceCredential` of a
   `drive_import` job.

The worker opens the token, downloads `files/{id}?alt=media` from the Drive API,
and clears the sealed value the moment the job completes, fails permanently, or
is cancelled. A job requeued after a transient error keeps it, because it can
still download until the token expires, about an hour after the person signed
in. The token never appears in logs, error messages, responses or Operation
Status.

A Drive import whose token has expired fails with "Your Google Drive access
expired. Choose the file again." No failure of a Drive Picker import can be
retried, because the token is gone: the project page and the configure step offer
**Choose the file again**, which returns to the upload page. A 403 from Drive
with a rate-limit reason is retried like a 429; other 403s
(`downloadQuotaExceeded`, `cannotDownloadAbusiveFile`) are final.

## Create the Google Cloud app

1. In Google Cloud Console, create a project (or use the existing Narriflow one).
2. Enable **Google Drive API** and **Google Picker API**.
3. **Google Auth Platform > Branding / Audience**: set the app name, support and
   developer emails, and publish the app (Production). `drive.file` needs no
   Google review.
4. **Data Access**: add only `https://www.googleapis.com/auth/drive.file`.
5. **Clients > Create client > Web application**. Add every origin that serves
   the upload page as an **Authorized JavaScript origin** (for example
   `http://localhost:3000`, the Vercel dev URL, and production). No redirect URI
   is needed; the token client uses a popup.
   Copy the client ID to `NEXT_PUBLIC_GOOGLE_CLIENT_ID`.
6. **Credentials > Create credentials > API key**. Restrict it to **HTTP
   referrers** (the same origins) and **Google Picker API**. Copy it to
   `NEXT_PUBLIC_GOOGLE_API_KEY`.
7. `NEXT_PUBLIC_GOOGLE_APP_ID` is the **project number** (not the project ID)
   from the Cloud Console dashboard.
8. Make sure `SOCIAL_TOKEN_ENCRYPTION_KEY` is set to the same value in web and
   worker. The worker cannot open a token sealed under another key; such a job
   fails permanently.

## Create the Dropbox app

1. In the Dropbox App Console, **Create app**. Choose **Scoped access**, then
   **App folder** or **Full Dropbox** (the Chooser needs no API scopes), and name it.
2. On the app's **Settings** page, under **Chooser / Saver / Embedder domains**,
   add every domain that serves the upload page (for example `localhost`, the
   Vercel dev domain, and production). Dropbox refuses the Chooser elsewhere.
3. Copy the **App key** to `NEXT_PUBLIC_DROPBOX_APP_KEY`.
4. A new Dropbox app is limited to development use (50 linked users) until
   Dropbox approves it for production. Apply from the app's **Production** section
   before launch.

## Verify

1. Set the variables in `apps/web/.env.local`, restart the web app, and open
   `/upload`. An **Import from** row shows one button per configured picker, and
   no row appears when none is configured.
2. Drive: choose a short video. The commit step opens with its name as the title.
   After **Import & continue** the project downloads and reaches the configure step.
3. In the database, `IngestJob.sourceCredential` is set while a `drive_import`
   job is queued or running and is null once it finishes.
4. Expiry: wait for the token to lapse (or pick, then revoke access at
   <https://myaccount.google.com/permissions>) before the worker claims the job.
   The project fails with the "Choose the file again" message.
5. Dropbox: choose a short video. It continues exactly as a pasted Dropbox link.

## Troubleshooting

- **Popup blocked.** The page shows "We couldn't open Google Drive" or "Dropbox".
  Allow pop-ups for the site. The scripts preload so the click still opens the popup.
- **`origin_mismatch` or a blank Picker.** An origin is missing from the Google
  client's Authorized JavaScript origins, or the API key's referrer restriction
  excludes it.
- **Dropbox "domain not allowed".** Add the domain to the Chooser domains list.
- **"That Google Drive sign-in can't be used here."** The token's client is not
  the web server's `NEXT_PUBLIC_GOOGLE_CLIENT_ID`, or the server doesn't have that
  variable at run time, or `drive.file` was not granted.
- **Drive imports fail with an invalid-payload code.** The worker's
  `SOCIAL_TOKEN_ENCRYPTION_KEY` is missing or differs from the web app's.
