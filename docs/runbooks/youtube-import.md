# YouTube imports

A YouTube link import runs as the `fetch_source` native operation. It runs in one
of two places: the Modal `fetch_source` Function (through the download service
or an HTTP proxy), or the outbound laptop fetch agent in development. The Worker chooses with
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

## Download service (Modal, preferred)

When the Modal secret `narriflow-dev-youtube-fetch` holds `APIFY_API_TOKEN`
(with `YOUTUBE_FETCH_MODE=proxy`), Modal never talks to YouTube. It asks the
Apify Actor `coder2077/youtube-video-downloader` (backed by fastsaver.io) for a
1080p MP4 link (`youtube_download_service.py`), refuses a video over the plan's
duration cap before the transfer, then fetches that link once through the
guarded direct-download path and publishes it like any remote original: probe,
hash, Source Audio extracted from the same file (`run_service_youtube_source`).
The proxy settings below are ignored while the token is set.

- Cost: $0.00169 per video plus a negligible Actor start fee, billed to the
  Apify account; failed links are free.
- The link lasts about five minutes and allows three opens, so it is never
  stored or retried later; a retry of the operation resolves a new link.
- A video the service cannot fetch fails as `source_provider_access_denied`
  (upload instead). A rejected token or exhausted credit (401/402/403) is the
  permanent `source_download_failed`; a service outage is the retryable one.
- Logs: `{"message":"youtube_download_service","outcome":"resolved","host":...}`;
  never the token or the file URL.
- The token belongs only to the Modal secret. Rotate it in the Apify console
  (Settings, API & Integrations) and re-create the secret.

## Proxy mode (Modal)

`modal_app.py` reads `YOUTUBE_FETCH_MODE`, `YTDLP_STATIC_PROXY_URLS` and
`YTDLP_PROXY_URL` from the Modal secret `narriflow-dev-youtube-fetch`. Proxy
credentials belong only to that secret, never to the API or the repository. HTTP
proxy URLs only; credentials must be URL-encoded (a comma in a password is
`%2C`). The proxies apply to YouTube imports only. Proxy mode needs at least one
of the two URL settings.

Each import tries its exits in this order (`proxy.py`):

1. **Fixed ISP addresses** (`YTDLP_STATIC_PROXY_URLS`): up to five
   comma-separated URLs without a `{session}` placeholder. Each is tried once,
   starting from a random address so imports spread across the pool. A flat
   monthly fee per address; this is the intended route.
2. **Rotating sticky sessions** (`YTDLP_PROXY_URL`): the residential last
   resort, leave it unset unless the owner decides otherwise. Put `{session}` in
   the username; the runtime binds three fresh session IDs per import.

Metadata, media transfer and retries within one attempt share one exit. When
YouTube blocks a command (bot check or HTTP 403/429), `fetch.py` moves to the
next exit and extracts again; committed Source Audio is kept and never uploaded
again. When every exit is blocked, the import fails as
`source_provider_access_denied` and the user is sent to file upload. Only a
YouTube block moves to the next exit: a dead proxy, a proxy authentication
failure (407) or any other transport error ends the import on that exit, and all
exits share the operation's 45-minute deadline. A fixed URL
with `{session}`, a rotating URL without it, an empty list entry or more than
five fixed addresses, or the same address twice is refused before work starts as
the permanent failure `youtube_proxy_invalid`. The bgutil plugin
forwards the bound proxy to token generation; the loopback token server bypasses
it. There is no direct fallback if the proxies are unavailable.

Every attempt logs one line such as
`{"message":"youtube_fetch_route","route":"static-2","outcome":"blocked"}`.
Routes are `static-N` (position in `YTDLP_STATIC_PROXY_URLS`) or `rotating-N`;
outcomes are `downloaded`, `blocked`, `failed` (with its failure `code`) or
`interrupted`. The URL and exception text are never logged. A fixed address that
keeps logging `blocked` needs replacing.

```dotenv
# Fixed ISP addresses (example shapes; use the provider's host and port)
YTDLP_STATIC_PROXY_URLS=http://USER:PASSWORD@203.0.113.7:3128,http://USER:PASSWORD@203.0.113.8:3128
# Residential last resort, normally unset. DataImpulse: sticky session about 30 minutes
# YTDLP_PROXY_URL=http://LOGIN__cr.us;sessid.{session}:PASSWORD@gw.dataimpulse.com:823
```

Imports use roughly 270 to 300 MB per hour of source video (measured October
2026), so about $0.30 per imported hour at $1/GB. Blocked attempts fail before
the media transfer. Choose a plan that permits Google/YouTube and video
transfer, test with a short video first and watch the provider's bandwidth
balance. Do not paste credentials into shell history or enable yt-dlp verbose
logs with real credentials.

`YOUTUBE_PROXY_ACCEPTED=true` is set on the API only after the configured proxy
passes the gates below.

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
