# YouTube imports

The worker image bundles yt-dlp 2026.08.19, EJS 0.8.0, Deno 2.9.5, and
bgutil PO-token provider/plugin 2.0.0. The worker starts the provider on
127.0.0.1:4416 before opening its health endpoint or claiming work. If the
provider exits, the worker stops its loops and exits unsuccessfully so the
host can restart it. Generated tokens and application credentials are not
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
No additional Railway service, port, cookie secret, or environment override is
needed. Check for `youtube_token_server_ready` before testing imports.

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

## Remaining provider restrictions

Deno and PO tokens do not guarantee access from every hosting IP. If this setup
still returns the bot check, record the failure and test controlled egress or a
managed media provider. Keep extraction and media transfer on the same outbound
session. Do not keep retrying a blocked job or add account cookies by default.

References: [EJS](https://github.com/yt-dlp/yt-dlp/wiki/EJS),
[PO tokens](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide),
[bgutil](https://github.com/Brainicism/bgutil-ytdlp-pot-provider).
