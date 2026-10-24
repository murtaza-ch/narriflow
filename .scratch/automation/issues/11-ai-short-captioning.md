# 11 - AI-short captioning (the previous map's "Finish" pilot)

**What to build:** A caller sends a short finished video, such as an AI-generated short. Narriflow captions it from speech or from supplied captions, applies the Brand Profile, frames it Fit (whole frame) or Center (cover crop), and exports it. There is no clip detection. Silent videos are allowed.

**Blocked by:** [04 - Finishing](04-finishing.md) (shares export settings).

**Status:** done

**Map:** previous map "Finish path" under Codebase readiness lists every code point.

## Behavior

- Input: an Upload Session or supported link, up to 3 minutes. Options:
  - `framing` (`fit` or `center`)
  - `aspectRatios`
  - `resolution`
  - `brandProfileId`
  - `captions`: `auto` (speech-to-text), `supplied` (SRT or WebVTT text, bounded size), or `none`
  - `callback`
- New REST `POST /api/v1/captioned-videos` and MCP tool; new command with `processing.consume` and `processing:write`. Minutes are metered by probed duration, as for any intake.
- The Project gets one whole-source clip instead of detected moments. A generation run with a "whole source" mode skips moment detection and creates the single clip.
- Fix the blockers the previous map listed:
  - Speech-to-text is skipped when the source has no audio stream, or when captions are `supplied` or `none`.
  - An empty transcript is valid in this mode.
  - Supplied captions are parsed, bounded, and normalized into the existing utterance and word model (`packages/validators/src/transcript.ts`), so caption rendering uses the one cue model.
  - The 10 to 120 second editor boundary allows 1 to 180 seconds for whole-source clips. Change the boundary policy, its encode and decode validation, and the Studio trim guards together.
  - Silent output uses `-an`.
- Framing is reported back. When Center crops a frame with no detected subject, Operation Status carries a `framing_degraded` notice.
- Operation Status, Completion Callbacks, and Workspace Events work as for other generations.
- Docs: a guide page and an n8n example for "caption my AI short."

## Acceptance criteria

- [x] Silent, speech, and supplied-caption inputs each produce a captioned (or uncaptioned) export at each requested ratio (worker tests with small fixture media through real FFmpeg; assert no drawtext errors in stderr).
- [x] 8-second and 3-minute sources pass editor validation; detected clips keep their existing limits.
- [x] Supplied caption parsing rejects malformed or oversized input with typed errors.
- [x] lint, typecheck, test, `test:workflow:db`, `test:integration-api:db`, `test:clip-editor-persistence:db` pass on the local Postgres.

## Comments

2026-10-24: implemented in a worktree, merged with ticket 02 (the captioned generation's `operation.finished` fires once, when its single export ends), Opus-reviewed, fixed in the main checkout: the export is admitted inside the transaction that completes detection (no race, no double export on retry); a generation's announced outcome is frozen on the detection run; whole-source clips use the probed duration as their edge (0.5 s rounding slack); the status read no longer loads the captions blob; supplied-caption parsing strips only WebVTT tags, keeps file order, rejects 60+ minutes or seconds; `wholeSource` is a required decode argument. Verified: biome, typecheck, `bun run test`, workflow 153, integration-api, clip-editor-persistence, upload-session, processing-usage, library-search, vizard-expansion gates. Limits: MCP accepts links only; `framing_degraded` ignores display rotation; a re-generation over 3 minutes pays for STT before failing; n8n template not run on a live instance.
