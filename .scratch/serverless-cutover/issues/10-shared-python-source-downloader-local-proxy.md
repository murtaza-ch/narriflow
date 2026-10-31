# 10 - Shared Python source downloader (local + proxy)

**What to build:** Shared Python source downloader.

**Blocked by:** 06, 09

**Status:** claimed

**Spec:** [Serverless cutover](../spec.md)

- **Build:** §4.6: audio-first plus concurrent full video, identity/track manifest, pinned yt-dlp/Deno/token helper, config isolation, scoped multipart output, cap, finite retries, sticky HTTP proxy, strict egress. Direct/RSS/Drive/Zoom adapters keep guarded transport.
- **Files:** `apps/media/python/narriflow_media/{fetch,proxy,manifest}.py`, `apps/media/src/fetch-source.ts`, the normalized probe CLI, `modal_app.py`, fixtures.
- **Accept:** laptop-direct and Modal-proxy produce identical manifests for a frozen source. Audio commits before video. Proxy rotation stops at 3 sessions, never falls back to direct and never puts secrets in diagnostics. A controlled HTTP proxy fixture proves propagation through yt-dlp, FFmpeg and the token helper. The old TS downloader is deleted.

## Evidence

Preparation is in progress while executor control is integrated. A controlled HTTP proxy fixture sends real yt-dlp 2026.8.19, FFmpeg and Deno 2.9.5 requests to a reserved `.invalid` source through one bound sticky proxy. No public source is fetched. Python is pinned to 3.13.5.

The proxy contract accepts HTTP only, requires an explicit sticky-session credential template, rejects malformed configuration without echoing credentials, supplies the same bound proxy to tool arguments and the token-helper environment, and issues at most three fresh sessions. Proxy credentials are excluded from representations and manifests.

Twenty-two Python tests pass through the project-managed Python 3.13.5 environment. Source manifest tests cover exact upstream identity, whole-source audio duration/track facts, no URL/path/secret payload, and the probe version emitted by the shared TypeScript CLI. The native adapter also downloads a frozen info-JSON source through the controlled HTTP proxy and probes the real file through the shared Bun CLI. This is a reserved fixture, not a real YouTube extraction. Declared tool versions are read from `runtime-lock.json`; measured host fingerprints remain explicit inputs. The image context now includes current workspace manifests without including other app source, so it supports the candidate on both sides of the final app deletion.

The shared Python coordinator starts audio/video concurrently, publishes verified audio while video is pending, re-extracts metadata for each sticky-session rotation, retains the single committed audio across video retries, and rejects mismatched video facts before its sink runs. Streaming hashes and file snapshots detect mutation during probe/hash and expose an immutability check for upload sinks. Async cancellation waits until the owned native process is stopped. Native commands reject unbounded output, use no shell, ignore user config/plugins, disable remote JS components and receive only explicit proxy routing.

This is not yet the full proxy acceptance gate: HTTPS CONNECT and the actual pinned token-helper requests remain to be tested; hard egress enforcement must be proven in the execution environment. Owned token-helper lifecycle, real provider acquisition, scoped multipart sink, toolchain readiness and domain control wiring remain open. The old TS acquisition path remains until the replacement and gates are complete.
