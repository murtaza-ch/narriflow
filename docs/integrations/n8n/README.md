# n8n templates

Three templates use only the public REST API: Drive folder to clips (below),
[`caption-ai-short.json`](caption-ai-short.json), which captions a finished
short, and [`autopilot-to-slack.json`](autopilot-to-slack.json), which posts
clips that Narriflow finished on its own to Slack
([its section](#n8n-template-autopilot-clips-to-slack) is at the end). The second
downloads a video from a URL, uploads it with
`POST /captioned-videos` (`source.kind: "upload"`), waits for the export on the
same signed-callback pattern as the first (the intake's Operation Status
follows the export), stops with Narriflow's failure code if captioning failed,
and fetches one MP4 per requested format. It needs the same credential,
variables, and callback secret. Its code nodes are syntax-checked and its
request builder dry-run offline; a recorded run is pending like the first's.

# n8n template: Drive folder to clips

[`drive-to-clips.json`](drive-to-clips.json) turns each new video in a Google
Drive folder into exported clips. It saves the MP4 and SRT files to another
Drive folder and posts a summary with the Narriflow review link to Slack. It
uses only HTTP Request, Wait, Code, Google Drive, and Slack nodes with the
[public REST API](../rest-api.md).

## Flow

1. **New video in Drive** polls the input folder; **Download video** fetches the
   files, and **One file at a time** runs the rest of the flow once per file,
   looping back after each Slack post.
2. **Prepare upload** builds idempotency keys from the execution ID, the Drive
   file ID, and the action name, so several files in one run never collide.
3. **Open upload** calls `POST /uploads` with `transfer: "single"`, and
   **PUT file to storage** sends the bytes to the signed URL.
4. **Finalize with callback** calls `POST /uploads/{id}/finalize` with
   `callback.url = {{$execution.resumeUrl}}/intake`.
5. **Read intake** reads the operation once. If it already finished, the
   workflow skips the wait. Otherwise **Wait for intake** waits on the webhook
   suffix `intake`.
6. On resume, **Verify intake event** checks the Standard Webhooks signature
   and timestamp, that the event's `operationId` is the one this execution
   waits for, and that its event ID is new. It reads the raw body through
   n8n's binary helper, so filesystem and S3 binary storage both work.
   Anything else returns to waiting.
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

## Let Narriflow finish the clips

Steps 7 and 8 export clips from the flow. Narriflow can do that itself: add a
`finishing` object to the **Open upload** body (for example
`{"topClips": 3, "copyPlatforms": ["tiktok"]}`) and, when the generation
completes, it exports the best clips and writes copy as the API key's user,
then emits a `finishing.finished` event. A variant of this flow would replace
**List top clips** and **Export clip** with a poll of
`GET /events?types=finishing.finished` and use the event's `exportIds` with
**Download grants**. The template as shipped keeps the explicit steps. Finishing needs
`campaign.operations`, which every plan with API access includes; if the plan
changes before it runs, the event arrives `skipped` with `plan_required`. The
settings are documented in [the REST guide](../rest-api.md#finishing).

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
- **Verify intake event**, reading the body through a stubbed binary helper,
  accepts an event signed by Narriflow's signer during
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

# n8n template: Autopilot clips to Slack

[`autopilot-to-slack.json`](autopilot-to-slack.json) posts to a Slack channel
each time Narriflow finishes clips with no request from the workflow: an
Autopilot rule imported an episode, or a request asked for
[finishing](../rest-api.md#finishing). Nothing starts the work, so there is no
callback to wait on. The workflow reads the Workspace Event feed
([events guide](../../../apps/web/content/docs/api/events.mdx)) from a cursor
instead. It needs no callback secret and no public URL.

## Flow

1. **Every 5 minutes** starts a run. **Read cursor** loads the last handled
   event from the workflow's static data, and **Have a cursor?** routes the run.
2. First run, with no cursor: **Newest finishing event** calls
   `GET /events?types=finishing.finished&order=desc&limit=1`, and **Start from
   newest** stores its `seq` as the cursor. Nothing is posted, so activating the
   workflow doesn't replay up to 30 days of history.
3. Later runs: **Poll finishing events** calls
   `GET /events?types=finishing.finished&limit=100&after=<cursor>`, and
   **Finished events** keeps the runs that ended `ready` or `partial` with at
   least one export. A run that ended `skipped` has nothing to post and only
   moves the cursor.
4. **One event at a time** loops over what is left. For each export of the
   event, **Download grants** calls `GET /exports/{id}/download`, and **Read
   clip** calls `GET /clips/{id}` for the clip's title. **Compose message**
   builds one Slack message with each clip's title, a download link, and a link
   to the clip in Narriflow. **Anything to post?** passes it to **Post to
   Slack**, and **Save event cursor** stores the event's `seq`.
5. When the loop ends, **Save page cursor** stores the page's `nextCursor`, which
   also covers skipped runs after the last post.

The cursor moves only after an event is handled, so a failed run resumes after
the last event that was handled. Delivery is at least once. A run reads one page
of up to 100 events; a backlog drains over the next runs. The Download Grants in
the message expire 15 minutes after they are issued, so the message says to open
the clip in Narriflow for a fresh link.

**Download grants** and **Read clip** return the HTTP status as data (the
node's *Never Error* and *Include Response Headers and Status* options) instead
of failing. A `404` means the export or its clip was deleted: **Compose
message** leaves a deleted export out, shows a clip that is gone as "Untitled
clip" with its download link, and when nothing is left the run still moves on
and saves its cursor. Any other status stops the run with a message naming the
status, so a revoked key or an outage is retried on the next run rather than
skipped. A deleted export therefore can't block the cursor. The one request that
reads a missing clip uses an ID that cannot exist, so the node chain keeps one
item per export.

The cursor lives in workflow static data, which n8n keeps only for an active
workflow. A manual test run has no cursor, so it starts from the newest event
and posts nothing; activate the workflow to see messages.

## Setup

1. In Narriflow, open **Settings → Developer access** and create an API key. The
   default read permissions are enough (`projects:read` for the feed and clips,
   `exports:read` for downloads); the template makes no write call.
2. In n8n, create the **Header Auth** credential `Narriflow API key` as for the
   Drive template (name `Authorization`, value `Bearer nf_…`) and select it on
   the four Narriflow HTTP Request nodes. The key never goes in workflow JSON.
3. Define the n8n Variable `NARRIFLOW_URL`, for example
   `https://app.narriflow.com`.
4. Replace `REPLACE_WITH_SLACK_CHANNEL`, connect the Slack credential, and
   activate the workflow.
5. Turn on finishing where the clips come from: the Autopilot rule's finishing
   settings, or a `finishing` object on the request.

## Verification

Checked in the repository (2026-10-24):

- The workflow graph has no dangling connections, the JSON holds no secrets,
  and every Code node parses.
- The Code nodes and the request URLs ran offline against stubbed n8n globals:
  a first run stores the newest `seq` (or `0` for an empty feed) and posts
  nothing; later runs post every ready or partial event after the cursor and
  only move the cursor past skipped ones; one request is built per export; a
  deleted export is left out of the message, a deleted clip still shows its
  download, and a run whose exports are all gone posts nothing but still
  reaches the cursor save; a `500` or `401` stops the run; the Slack message
  escapes `&`, `<`, and `>` in clip titles; the per-event and per-page cursor
  saves write the expected values.

Pending: a recorded run on a real n8n instance with a Slack workspace and a
Narriflow deployment that has a finishing run, which also needs the newest-first
event order (`order=desc`) on that deployment. Run each case and record the n8n
version and results here:

| Case | Expected | n8n version | Result |
| --- | --- | --- | --- |
| Activate the workflow with finished runs already in the feed | Nothing posted; the next new run posts | | |
| New `finishing.finished` event with two exports | One Slack message with two clips | | |
| One of the two exports was deleted | One clip in the message; the cursor moves | | |
| Slack fails on the second of two events | First event handled, workflow resumes at the second on the next run | | |
| Run that ended `skipped` | Nothing posted, cursor moves | | |
