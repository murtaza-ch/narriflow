# 03b - Worker painter

**What to build:** Dynamic cues burn in through per-word ASS events placed by the shared geometry (spec 5.6 painting, 5.7).

**Blocked by:** 03a

**Status:** ready-for-agent

Spec: [../spec.md](../spec.md). Follow the spec; where a ticket and the spec disagree, the spec wins.

## Acceptance

- [ ] Per-word measurement with `layoutCaptionLine` on single words; per-word, per-layer events from word start to cue end with `\pos`, `\org`, `\frz`, motion tags; tiles as `\p1` shapes.
- [ ] Classic snapshot from 00 unchanged except where soft cue breaks change cue input (the snapshot uses fixed cues, so it must be byte-identical).
- [ ] `apps/media/scripts/caption-frames.ts` renders fixture cases full-frame on the three backgrounds at the spec section 9 times.
- [ ] A real-libass test (pattern of `caption-pill-render.test.ts`) finds each word's ink where the geometry says, within section 11 tolerances.
- [ ] `bun run lint`, `bun run typecheck`, `bun run test` pass (Bun 1.4.4). No PostgreSQL or heavy suites.

## Comments
