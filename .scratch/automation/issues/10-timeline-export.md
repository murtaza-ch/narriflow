# 10 - Timeline export for editors

**What to build:** For a clip, download a timeline that opens in Premiere Pro (FCP7 XML), Final Cut Pro and DaVinci Resolve (FCPXML), or any editor (CMX3600 EDL). It cuts the original source at the clip's source timestamps and comes with an SRT of the captions and the original media.

**Blocked by:** None.

**Status:** done

## Behavior

- Pure generator functions in `packages/services` take the clip's resolved edit ranges on the source (the same timing the render uses, `resolveClipRenderTiming` in validators), the source media facts (frame rate, duration, dimensions from the stored probe), and the caption cues (`deriveCaptionCues`). They produce `xmeml` v5, FCPXML 1.11, and CMX3600 EDL strings.
- Timecode math is exact for integer and drop-frame-free rates; NTSC rates (29.97, 23.976, 59.94) use rational frame durations.
- The timeline references the source file by a stable file name and is shipped beside it. Download is a zip containing the timeline, the SRT, and the original source media (or a Download Grant for the source when the zip would exceed a sensible size, documented).
- Endpoints:
  - Browser: export page action.
  - REST: `GET /api/v1/clips/{id}/timeline?format=xmeml|fcpxml|edl` returns the timeline text plus a source Download Grant. Add a command with `content.download` and `exports:read`.
  - MCP: extend `narriflow_get_export_download` or add a read tool, whichever fits the command table.
- Scenes, overlays, and captions burned by Narriflow are not reproduced as editable layers. Say so in the docs; captions come as SRT.
- Golden-file tests per format and a structural check: xmeml parses as XML with the expected sequence and clip items; FCPXML validates against Apple's DTD if the DTD is available offline, otherwise structural assertions.

## Acceptance criteria

- [x] Generators exact for 23.976, 25, 29.97, 30, 59.94 fps sources (unit tests).
- [x] Multiple edit ranges per clip become multiple cuts in order.
- [x] Browser, REST, and MCP access with the right scopes.
- [x] Docs page with editor import steps.
- [x] lint, typecheck, test pass.

## Comments

2026-10-24: implemented in a worktree, Opus-reviewed (frame-rate choice now prefers `r_frame_rate`, non-standard rates refused with `timeline_source_rate_unsupported`, record frames derived from edited times so 20 cuts don't drift, embedded start timecode and drop-frame sources supported, SRT built from the same cut plan), merged with 01 and 06. Added `Project.sourceProbe` (migration `20261024000000_project_source_probe`); Projects ingested earlier return `timeline_source_unmeasured`. Verified in the main checkout: biome, typecheck, `bun run test`, and the workflow, processing-usage, upload-session, integration-api, brand-profiles, vizard-expansion, and authenticated-request-policy DB gates. FCPXML validated against Apple's 1.10 DTD with the version relaxed. Not opened in Premiere, Final Cut, or Resolve yet.
