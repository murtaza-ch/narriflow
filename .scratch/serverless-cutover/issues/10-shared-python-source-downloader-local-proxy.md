# 10 - Shared Python source downloader (local + proxy)

**What to build:** Shared Python source downloader.

**Blocked by:** 06, 09

**Status:** ready-for-agent

**Spec:** [Serverless cutover](../spec.md)

- **Build:** §4.6: audio-first plus concurrent full video, identity/track manifest, pinned yt-dlp/Deno/token helper, config isolation, scoped multipart output, cap, finite retries, sticky HTTP proxy, strict egress. Direct/RSS/Drive/Zoom adapters keep guarded transport.
- **Files:** `apps/media/python/narriflow_media/{fetch,proxy,manifest}.py`, `apps/media/src/fetch-source.ts`, the normalized probe CLI, `modal_app.py`, fixtures.
- **Accept:** laptop-direct and Modal-proxy produce identical manifests for a frozen source. Audio commits before video. Proxy rotation stops at 3 sessions, never falls back to direct and never puts secrets in diagnostics. A controlled HTTP proxy fixture proves propagation through yt-dlp, FFmpeg and the token helper. The old TS downloader is deleted.

## Evidence

Pending implementation and verification.
