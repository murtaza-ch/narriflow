# 06 - Dubbing panel and API client

**What to build:** Spec §6 surfaces in `apps/web/app/(app)/projects/[projectId]/dubbing-panel.tsx` and `packages/api-client` dubbing domain: all clips selectable, audio available on completion, video states (rendering / ready / failed with Render again), copy without the render prerequisite.

**Blocked by:** 04

**Status:** done

## Acceptance
- [x] Panel and client follow the new snapshot; follows docs/UI rules in memory (no greyed dead ends).
- [x] `bun run lint`, `bun run typecheck`, `bun run test`, `bun run check:web-split` pass.

## Comments

- 2026-11-19: Done (uncommitted). `packages/api-client` has no separate dubbing domain (dubs live in `projects`), so the render command is `projectCommands.renderDubVideo` in `projects/mutations.ts`; the panel invalidates the Project (dubs ride in its detail) and the existing terminal-progress invalidation settles `rendering`. Panel: every clip selectable, format picker offers all aspect ratios, render-prerequisite copy removed; row shows Audio once completed, Video only when `video.status === "ready"`, "Rendering video" badge while rendering, danger copy plus "Render again" for `failed` or `none` with an `errorCode` (`none` without a code offers "Render video"; members who cannot edit see "No video yet"). A failed dub gets a "Dub again" action with the same clip/format/language/voice, since the unfit copy tells the user to try again. Error copy added in `packages/validators/src/error-messages.ts` for `dub_transcript_empty`, `dub_transcript_untimed_cut`, `dub_transcript_too_long`, `dubbing_censor_unsupported`, `dubbing_clip_too_long`, `dub_narration_unfit`, `dub_provider_rejected`, `dub_clip_superseded`, `dubbing_clip_superseded`, `dub_video_not_started`. Tests: `project-panels.test.tsx` (20 pass), `error-messages.test.ts` (22 pass).
- Verification: `bun run lint` 0 errors (20 existing warnings); `bun run typecheck` 15/15; `bun run test` 14/14 (media 892 pass); `bun run check:web-split` passes (bundle not scanned).
