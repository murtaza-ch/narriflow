# Link sources beyond YouTube and Dropbox

**Status:** documented only, not scheduled. Owner decision, 2026-11-04.

## Today

Intake accepts YouTube and Dropbox links, RSS, Zoom and the Google Drive Picker. Every other link is refused with `link_unsupported_source` before credits are reserved. The removed `extractor_source` path never worked: it was accepted, reserved credits, then failed with `source_runtime_invalid`.

## Market, checked 2026-11-04

- [OpusClip](https://help.opus.pro/docs/article/what-import-sources-does-opusclip-support.md): Apple Podcast, YouTube, Google Drive, Vimeo, Zoom, Zoom Clips, Rumble, Twitch, Facebook, LinkedIn, X, Dropbox, Riverside, Loom, Frame.io, StreamYard, Kick, Medal.tv, public MP4 URLs. Public or unlisted videos only.
- [Vizard API](https://docs.vizard.ai/docs/basic): direct files, YouTube, public Google Drive, Vimeo, StreamYard, TikTok, Twitch, Loom, Dropbox.

## Proposed order

1. **First:** Vimeo, Twitch, Loom, StreamYard, and public Google Drive links. All appear on both lists, and they carry long-form video.
2. **Later:** Rumble, Kick, Riverside, Frame.io, public MP4 URLs.
3. **Hold:** TikTok, X, Facebook, LinkedIn. Mostly short-form, and the most likely to block extraction.

## Before building any source

- Read that platform's terms and record the outcome here. Not done yet.
- Prefer an official API or OAuth over extraction, as Zoom does.
- Support public and unlisted videos only.
- Use `direct_source` where the platform gives a direct file URL. A real extractor path needs its own runtime, proxy cost estimate and failure mapping.
- Enforce duration and live-stream checks before download, as YouTube now does.
- Keep refusal before reservation: a source that cannot succeed must never reserve credits.
- Update `LINK_PROVIDERS`, web copy, docs and the REST and MCP descriptions in the same change.
