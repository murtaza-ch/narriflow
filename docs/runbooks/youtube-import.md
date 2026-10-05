# YouTube imports

The worker image bundles yt-dlp 2026.08.19, EJS 0.8.0, Deno 2.9.5, and
bgutil PO-token provider/plugin 2.0.0. The worker starts the provider on
127.0.0.1:4416 before claiming YouTube work. If startup fails or the provider
later exits, YouTube link intake is marked unavailable while the other worker
loops remain available. Generated tokens and application credentials are not
forwarded between provider logs and the worker environment.

Metadata and download commands use the same `mweb` client, Deno and local token
provider. `--ignore-config` prevents machine-specific yt-dlp configuration from
changing the import policy. Tokens are generated automatically for each video.
No account cookies, static tokens, remote script downloads, or public token
server are required. A YouTube bot-check response is a permanent
`source_provider_access_denied` failure, using the existing file-upload recovery.

## Local container

Build from the repository root. Use a development database, not a live worker's
queue, when running another worker locally.

```sh
docker build -f apps/worker/Dockerfile -t narriflow-worker .
docker run --rm --env-file apps/worker/.env narriflow-worker
```

Do not publish port 4416. The web app still needs its own environment file.
The worker image contains no application secrets.

## Native development

Install Deno 2.9.5 and FFmpeg first. Use Python 3.10 or newer. From the repository
root, prepare the pinned dependencies. The server's lockfile pins npm dependencies.

```sh
python3 -m venv apps/worker/.venv/youtube
apps/worker/.venv/youtube/bin/pip install 'yt-dlp[default]==2026.8.19' 'bgutil-ytdlp-pot-provider==2.0.0'
git clone --depth 1 --branch 2.0.0 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git apps/worker/.venv/bgutil
cd apps/worker/.venv/bgutil/server
npm ci --omit=dev --no-audit --no-fund
deno cache --frozen src/main.ts
```

Set `YTDLP_POT_SERVER_HOME` in `apps/worker/.env` to the absolute path of that
server directory. Set `YTDLP_EXECUTABLE` to the absolute path of
`apps/worker/.venv/youtube/bin/yt-dlp`, so the native worker uses the installation
with the plugin without changing your existing face-detection Python environment.
The worker starts and stops the token server itself. Only one worker process can
own port 4416 on a native host; separate containers have separate loopback ports.

## Deployment and verification

Deploy the worker Dockerfile through the existing Railway GitHub `dev`
integration. Keep its start command as `bun run apps/worker/src/index.ts`.
No additional Railway service or public port is needed. For proxy access, set
the worker variable described below. Check for `youtube_token_server_ready` and
`youtube_network_configured` before testing imports. The latter logs only
`direct` or `proxy`, never credentials.

The image build runs `apps/worker/scripts/check-youtube-token-server.ts`, which
starts the provider through the worker's own launch code against the files the
image ships. If the launch cannot work in that image, the Railway build fails and
the previous deployment keeps serving. Run the same script natively after
changing the launch arguments or the provider version.

The provider image copies `package.json`, `deno.lock`, `node_modules` and `src`,
but not `deno.json`. The launch must not name files the image omits. An explicit
`--config=deno.json` once made every start fail instantly in production while it
passed against a full Git checkout.

When intake is unavailable, `youtube_link_intake_unavailable` reports `reason`,
`exitCode` and a short `detail` taken from the provider's stderr before it
became ready. That output precedes any request, so it contains no generated
token; stdout and later stderr are never logged. Restarts back off from five
seconds to five minutes and reset after a successful start.

From the worker console:

```sh
curl --fail http://127.0.0.1:4416/ping
yt-dlp --ignore-config --no-js-runtimes --js-runtimes deno --no-playlist \
  --extractor-args 'youtube:player_client=mweb' \
  --extractor-args 'youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416' \
  --skip-download --print '%(id)s | %(title)s | %(duration)s' \
  'https://www.youtube.com/watch?v=9aSKMf5nCk0'
yt-dlp --ignore-config --no-js-runtimes --js-runtimes deno --no-playlist \
  --extractor-args 'youtube:player_client=mweb' \
  --extractor-args 'youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416' \
  --format 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best' \
  --merge-output-format mp4 --concurrent-fragments 4 --no-progress \
  --print after_move:filepath -o '/tmp/youtube-check/%(id)s.%(ext)s' \
  'https://www.youtube.com/watch?v=9aSKMf5nCk0'
ffprobe -v error -show_entries format=duration,size:stream=codec_type,width,height \
  -of json /tmp/youtube-check/9aSKMf5nCk0.mp4
```

Then retry the failed import in the app and verify it reaches ready, has an R2
source, and does not requeue the same bot-check failure. Repeat full downloads
with several videos and after a worker restart. A metadata-only success does
not establish that the media server accepts the download.

## Proxy configuration

Set `YTDLP_PROXY_URL` privately in Railway's worker variables and in
`apps/worker/.env`. HTTP, HTTPS and SOCKS proxy URLs are supported. Credentials
must be URL-encoded. The variable applies only to YouTube imports; R2, database,
AI services and other link providers keep their existing network configuration.
An empty value explicitly uses a direct connection, ignoring machine-wide proxy
environment variables for YouTube. Malformed configuration prevents worker startup.

Use a residential proxy with sticky sessions. Server and datacenter proxy IPs
meet the same YouTube block as the worker. Put the `{session}` placeholder in the
username. The worker resolves it to a fresh session ID once per import, so
metadata, media transfer and transient retries share one exit IP. When YouTube
blocks a command (bot check or HTTP 403), the worker retries that command on a
fresh session, using at most three sessions per import. Each yt-dlp run extracts
its own media URLs, so a new session for the download alone is safe. A direct
connection or a proxy without `{session}` fails on the first block.
The bgutil plugin forwards the resolved proxy to token generation automatically;
requests to the loopback token server itself bypass the proxy. There is no direct
fallback if a configured proxy is unavailable.

Imports use roughly 270 to 300 MB per hour of source video (measured on Railway,
October 2026). At $1 per GB, that is about $0.30 per imported hour. Blocked
attempts fail before the media transfer and use little bandwidth.

For DataImpulse residential proxies ($1/GB pay-as-you-go, non-expiring traffic),
a sticky session lasts about 30 minutes. That covers typical imports, since the
media transfer takes minutes. Replace the placeholder credentials privately and
keep the literal `{session}` marker. The worker URL-encodes the `;` separator:

```dotenv
YTDLP_PROXY_URL=http://LOGIN__cr.us;sessid.{session}:PASSWORD@gw.dataimpulse.com:823
```

For Decodo, the documented endpoint with a three-hour session is:

```dotenv
YTDLP_PROXY_URL=http://user-USERNAME-session-{session}-sessionduration-180:PASSWORD@gate.decodo.com:7000
```

Choose a plan that permits Google/YouTube and video transfer. Test with a short
video first and watch the provider's bandwidth balance.

For the console commands above, add `--proxy "$YTDLP_PROXY_URL"` only when the
variable already contains a resolved session ID. To expand `{session}` exactly
as the application does, call `ytdlpCommonArgs("youtube")` once from a Bun script
and reuse the returned arguments for both commands. Do not paste credentials
into shell history or enable yt-dlp verbose/traffic logs with real credentials.

References: [yt-dlp network options](https://github.com/yt-dlp/yt-dlp#network-options),
[bgutil proxy forwarding](https://github.com/Brainicism/bgutil-ytdlp-pot-provider/blob/2.0.0/plugin/yt_dlp_plugins/extractor/getpot_bgutil_http.py),
[Decodo sticky sessions](https://help.decodo.com/docs/residential-proxy-custom-sticky-sessions),
[Decodo trial terms](https://help.decodo.com/docs/trials).

## Remaining provider restrictions

Deno and PO tokens do not guarantee access from every hosting IP. If this setup
still returns the bot check, record the failure and test controlled egress or a
managed media provider. Keep extraction and media transfer on the same outbound
session. Beyond the bounded session rotation above, do not keep retrying a
blocked job or add account cookies by default.

References: [EJS](https://github.com/yt-dlp/yt-dlp/wiki/EJS),
[PO tokens](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide),
[bgutil](https://github.com/Brainicism/bgutil-ytdlp-pot-provider).
