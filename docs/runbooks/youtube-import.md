# YouTube imports

A YouTube link import runs as the `fetch_source` native operation. It runs in one
of two places: the Modal `fetch_source` Function through a sticky HTTP proxy, or
the outbound laptop fetch agent in development. The Worker chooses with
`YOUTUBE_FETCH_MODE` (`proxy` or `local`). Neither place holds a database
credential: both reach the API only through signed executor control.

The pinned lean image (`apps/media/images/Dockerfile`) carries yt-dlp 2026.8.19,
yt-dlp-ejs 0.8.0, the bgutil PO-token provider/plugin 2.0.0 and the provider
image's Deno at `/opt/youtube-tokens`. The versions live in
`apps/media/pyproject.toml`; the runtime refuses to start if an installed version
differs. Each operation starts its own token provider on `127.0.0.1:4416`
(`apps/media/python/narriflow_media/token_helper.py`), reachable only from that
process.

Metadata and download use the same `mweb` client, Deno and token provider.
`--ignore-config` and an explicit plugin path keep machine-specific yt-dlp
configuration out of the import policy. Tokens are generated per video. No
account cookies, static tokens, remote script downloads or public token server
are used. A YouTube bot-check response is the permanent failure
`source_provider_access_denied`, which sends the user to file upload.

## Development: laptop agent

Set `APP_ENV=development`, `YOUTUBE_FETCH_MODE=local` and the Workspace in
`LOCAL_FETCH_WORKSPACE_IDS_JSON` on the API. The device key ring
(`DEV_DEVICE_KEY_ID`, `DEV_DEVICE_KEYS_JSON`) stays on the Worker. On Upload,
create a development fetch session, then run:

```sh
bun run fetch:local --session /absolute/private/device-session.json
```

The agent opens an outbound socket, checks the toolchain fingerprint
(`MEDIA_LOCAL_FETCH_TOOLCHAIN_FINGERPRINT`) before connecting, and runs the lean
Linux image in Docker. See [the media README](../../apps/media/README.md) for the
session lifetime and limits. Production routes refuse device execution.

## Proxy mode (Modal)

`modal_app.py` reads `YOUTUBE_FETCH_MODE` and `YTDLP_PROXY_URL` from the Modal
secret `narriflow-dev-youtube-fetch`. Proxy credentials belong only to that
secret, never to the API or the repository. HTTP proxy URLs only; credentials
must be URL-encoded. The proxy applies to YouTube imports only.

Use a residential proxy with sticky sessions. Datacenter proxy IPs meet the same
YouTube block as Modal. Put the `{session}` placeholder in the username. The
runtime (`proxy.py`) binds a fresh session ID per attempt, so metadata, media
transfer and retries within an attempt share one exit IP. When YouTube blocks a
command (bot check or HTTP 403), `fetch.py` retries on a fresh session, at most
three sessions per import. A proxy without `{session}` is refused as
`youtube_proxy_invalid`. The bgutil plugin forwards the bound proxy to token
generation; the loopback token server bypasses it. There is no direct fallback if
the proxy is unavailable.

```dotenv
# DataImpulse: sticky session about 30 minutes
YTDLP_PROXY_URL=http://LOGIN__cr.us;sessid.{session}:PASSWORD@gw.dataimpulse.com:823
# Decodo: three-hour session
YTDLP_PROXY_URL=http://user-USERNAME-session-{session}-sessionduration-180:PASSWORD@gate.decodo.com:7000
```

Imports use roughly 270 to 300 MB per hour of source video (measured October
2026), so about $0.30 per imported hour at $1/GB. Blocked attempts fail before
the media transfer. Choose a plan that permits Google/YouTube and video
transfer, test with a short video first and watch the provider's bandwidth
balance. Do not paste credentials into shell history or enable yt-dlp verbose
logs with real credentials.

`YOUTUBE_PROXY_ACCEPTED=true` is set on the API only after the configured proxy
passes the gates below. Proxy purchase is deferred.

## Verification

Run the image and Python suites before relying on a new image or provider
version:

```sh
uv run --project apps/media --extra deploy modal run apps/media/modal_app.py::verify_lean_runtime
```

Then import a short public video end to end and confirm the import reaches ready
with an R2 source, and that a repeat does not requeue the same bot-check
failure. Repeat with several videos. A metadata-only success does not establish
that the media server accepts the download. A failure reports a typed code
(`source_provider_access_denied`, `youtube_proxy_invalid`, `source_fetch_mode_forbidden`)
and never logs the proxy URL or a generated token.

## Remaining provider restrictions

Deno and PO tokens do not guarantee access from every hosting IP. If the bot
check persists, record the failure and test controlled egress or a managed media
provider. Keep extraction and media transfer on the same outbound session.
Beyond the bounded session rotation above, do not keep retrying a blocked job or
add account cookies by default.

References: [yt-dlp network options](https://github.com/yt-dlp/yt-dlp#network-options),
[EJS](https://github.com/yt-dlp/yt-dlp/wiki/EJS),
[PO tokens](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide),
[bgutil](https://github.com/Brainicism/bgutil-ytdlp-pot-provider),
[Decodo sticky sessions](https://help.decodo.com/docs/residential-proxy-custom-sticky-sessions).
