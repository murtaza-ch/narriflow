# 07 - Curved text

**What to build:** Rows can curve on an arc, with the Arc style and a Curve control (spec 5.11).

**Blocked by:** 06

**Status:** ready-for-agent

Spec: [../spec.md](../spec.md). Follow the spec; where a ticket and the spec disagree, the spec wins.

## Acceptance

- [ ] `curve` preset field, arc geometry and fish-eye in `caption-block.ts`, `captionClusterOffsets` in shaping, cluster events and elements, straight fallback for shaping-sensitive and no-space scripts.
- [ ] Arc style, Curve slider, fixture cases, real-libass cluster placement test.
- [ ] Sol visual review recorded.
- [ ] `bun run lint`, `bun run typecheck`, `bun run test` pass (Bun 1.4.4). No PostgreSQL or heavy suites.

## Comments
