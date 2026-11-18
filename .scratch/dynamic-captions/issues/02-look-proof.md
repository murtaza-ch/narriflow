# 02 - Look proof

**What to build:** A hand-built Headline frame (ASS + HTML) proves the target look and measures the render budget (spec section 8, gate G2).

**Blocked by:** None

**Status:** ready-for-agent

Spec: [../spec.md](../spec.md). Follow the spec; where a ticket and the spec disagree, the spec wins.

## Acceptance

- [ ] `references/proof/headline.ass` and `references/proof/headline.html` render Headline with the phase 2 gradient and the hero blur entrance over a real talking-head frame, using the worker's ffmpeg/libass and the vendored fonts.
- [ ] Frames at onset, +100 ms and settled are saved in `references/proof/`.
- [ ] Render time of a 20 s 1080x1920 clip with the heaviest look vs Bold Pop is measured and recorded here; events per cue are counted.
- [ ] G2 (Sol) recorded under `## Comments`.
- [ ] `bun run lint`, `bun run typecheck`, `bun run test` pass (Bun 1.4.4). No PostgreSQL or heavy suites.

## Comments
