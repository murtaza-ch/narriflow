# 00 - Classic ass snapshot

**What to build:** Classic presets keep their ASS output: a snapshot of all 24 classic presets on fixed cues in `apps/media/src/caption-ass.test.ts`.

**Blocked by:** None

**Status:** done

Spec: [../spec.md](../spec.md). Follow the spec; where a ticket and the spec disagree, the spec wins.

## Acceptance

- [x] One fixed cue set (English 3 words, Urdu 3 words, Japanese) rendered with every classic preset through `renderCaptionTrack`; the full ASS text is snapshotted.
- [x] The snapshot is committed and passes.
- [x] Spec reference: section 4 decision 5, section 10 ticket 00.
- [x] `bun run lint`, `bun run typecheck`, `bun run test` pass (Bun 1.4.4). No PostgreSQL or heavy suites.

## Comments

- 2026-11-19 (implementer): Added `describe("classic preset snapshot")` to `apps/media/src/caption-ass.test.ts`: three cues (en "Ready to go", ur "یہ بہت اچھا", ja "今日は|天気が|いい" with `spaceBefore: false`), each its own caption layer with its `language`, 0.5 s per word, cues 2 s apart, 1080x1920. One `test.each` per entry of `CAPTION_PRESETS` (24) renders through `renderCaptionTrack`, asserts a second render is identical, and snapshots the full ASS to `apps/media/src/__snapshots__/caption-ass.test.ts.snap` (24 entries, ~388 KB). Word measurement uses the pinned fonts in `packages/caption-fonts/fonts`, so the output does not depend on the machine.
  - `bun test apps/media/src/caption-ass.test.ts`: 48 pass, 0 fail, 24 snapshots added; re-run and `CI=true` re-run: 48 pass, 24 snapshots matched.
  - `bun run lint`: exit 0 (20 existing warnings, none in this file).
  - `bun run typecheck`: 15/15 tasks successful.
  - `bun run test`: 14/14 tasks successful, 0 fail.
