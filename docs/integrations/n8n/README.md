# n8n template: Drive folder to clips

[`drive-to-clips.json`](drive-to-clips.json) turns each new video in a Google
Drive folder into exported clips. It saves the MP4 and SRT files to another
Drive folder and posts a summary with the Narriflow review link to Slack. It
uses only HTTP Request, Wait, Code, Google Drive, and Slack nodes with the
[public REST API](../rest-api.md).

## Flow

1. **New video in Drive** polls the input folder; **Download video** fetches the file.
2. **Prepare upload** builds idempotency keys from the execution ID, the item
   index, and the action name, so several files in one run never collide.
3. **Open upload** calls `POST /uploads` with `transfer: "single"`, and
   **PUT file to storage** sends the bytes to the signed URL.
4. **Finalize with callback** calls `POST /uploads/{id}/finalize` with
   `callback.url = {{$execution.resumeUrl}}/intake`.
5. **Read intake** reads the operation once. If it already finished, the
   workflow skips the wait. Otherwise **Wait for intake** waits on the webhook
   suffix `intake`.
6. On resume, **Verify intake event** checks the Standard Webhooks signature
   and timestamp, that the event's `operationId` is the one this execution
   waits for, and that its event ID is new. Anything else returns to waiting.
   A valid event triggers a fresh read of Operation Status, which decides
   whether the intake is done.
7. **List top clips** and **Export clip** request 9:16 1080p exports of the top
   clips with `callback.url = {{$execution.resumeUrl}}/exports`. The export
   wait works the same way, with suffix `exports`, and continues once every
   tracked export is terminal.
8. **Download grants** fetches fresh download links and subtitles;
   **Save MP4** and **Save SRT** store them; **Post to Slack** sends the summary.

Each Wait node has its own suffix and the callback URL ends with that suffix.
Setting a suffix doesn't change `$execution.resumeUrl`, so the callback URL must
append it. Delivery is at least once, so the template treats a callback only as
a wake-up and Operation Status as the truth. A callback that arrives while no
wait is open is refused by n8n and retried by Narriflow's schedule; the read
before each wait covers work that finished early.

## Setup

1. In Narriflow (Business plan), open **Settings → API**. Create an API key
   with *import, upload and generate* and *request clip exports* enabled, and
   create the callback signing secret.
2. In n8n, create a **Header Auth** credential named `Narriflow API key` with
   name `Authorization` and value `Bearer nf_…`. Select it on every Narriflow
   HTTP Request node. The key never goes in workflow JSON.
3. Define these n8n Variables (or environment variables on self-hosted n8n):
   - `NARRIFLOW_URL`, for example `https://app.narriflow.com`.
   - `NARRIFLOW_CALLBACK_SECRET`, the `whsec_…` signing secret.
   - `NARRIFLOW_TOP_CLIPS`, optional, defaults to 3.
4. Self-hosted n8n must allow the Code node's `crypto` module
   (`NODE_FUNCTION_ALLOW_BUILTIN=crypto`) and must be reachable over public
   HTTPS on port 443, because Narriflow only calls public HTTPS callback URLs.
5. Replace `REPLACE_WITH_INPUT_FOLDER_ID`, `REPLACE_WITH_OUTPUT_FOLDER_ID`, and
   `REPLACE_WITH_SLACK_CHANNEL`, and connect the Google Drive and Slack
   credentials.

## Verification

Checked in the repository (2026-10-08):

- The workflow graph has no dangling connections, every Code node and
  expression parses, and the JSON holds no secrets.
- **Verify intake event** accepts an event signed by Narriflow's signer during
  a rotation overlap (two signatures) and rejects a duplicate event ID, a
  tampered body, another operation's event, and a stale timestamp.

Pending: a recorded run on a real n8n instance, which needs Google Drive and
Slack credentials and a public Narriflow deployment. Run each case and record
the n8n version and results here:

| Case | Expected | n8n version | Result |
| --- | --- | --- | --- |
| Small file (under 100 MiB) | Clips exported, MP4 and SRT saved, Slack posted | | |
| Large file (over 1 GiB, single PUT) | Same | | |
| Duplicated callback (redeliver after success) | Second event ignored as a duplicate | | |
| Callback before the Wait node opens | Read-before-wait skips the wait, or Narriflow's retry resumes it | | |

Publishing to n8n's template gallery is an outward-facing action that the
owner performs or approves at the time.
