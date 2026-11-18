# 00 - Classic ass snapshot

**What to build:** Classic presets keep their ASS output: a snapshot of all 24 classic presets on fixed cues in `apps/media/src/caption-ass.test.ts`.

**Blocked by:** None

**Status:** ready-for-agent

Spec: [../spec.md](../spec.md). Follow the spec; where a ticket and the spec disagree, the spec wins.

## Acceptance

- [ ] One fixed cue set (English 3 words, Urdu 3 words, Japanese) rendered with every classic preset through `renderCaptionTrack`; the full ASS text is snapshotted.
- [ ] The snapshot is committed and passes.
- [ ] Spec reference: section 4 decision 5, section 10 ticket 00.
- [ ] `bun run lint`, `bun run typecheck`, `bun run test` pass (Bun 1.4.4). No PostgreSQL or heavy suites.

## Comments
