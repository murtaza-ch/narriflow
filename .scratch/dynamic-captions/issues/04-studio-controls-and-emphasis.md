# 04 - Studio controls and emphasis

**What to build:** The Captions panel exposes the dynamic controls and the Emphasis row (spec section 7).

**Blocked by:** 03c

**Status:** ready-for-agent

Spec: [../spec.md](../spec.md). Follow the spec; where a ticket and the spec disagree, the spec wins.

## Acceptance

- [ ] Customize tab layout per section 7 (main controls, Advanced, hidden controls).
- [ ] Emphasis row: tap, Join next, No emphasis, Auto; `setCaptionEmphasis` in `editorActionSchema`, reducer, undo, contract test; `studioEdits.captionEmphasis` in `studioEditsEqual`.
- [ ] Drag semantics for centre and left styles; brand colour mapping for dynamic presets.
- [ ] `bun run lint`, `bun run typecheck`, `bun run test` pass (Bun 1.4.4). No PostgreSQL or heavy suites.

## Comments
