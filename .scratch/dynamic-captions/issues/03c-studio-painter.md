# 03c - Studio painter

**What to build:** The Studio previews dynamic cues with an absolute per-word painter driven by the playhead (spec 5.6, 5.7, section 7 last bullets).

**Blocked by:** 03a

**Status:** ready-for-agent

Spec: [../spec.md](../spec.md). Follow the spec; where a ticket and the spec disagree, the spec wins.

## Acceptance

- [ ] Canvas `measureText` measurement after fonts load; absolute per-word elements; transforms written imperatively per frame from `timeSec`; no mount-triggered animation for block cues; reduced motion shows settled words.
- [ ] The panel preview and thumbnails read the plan / `captionCueBlock`; `useLiveCaption`'s derivation and `getCurrentCaptionState` are deleted.
- [ ] `apps/web/app/prototype/caption-parity` loads fixture cases by id and seeks to a time.
- [ ] REST snapshot updated; public OpenAPI regenerated with `bun run --cwd apps/api openapi:generate` and `openapi:check` passes.
- [ ] `bun run lint`, `bun run typecheck`, `bun run test` pass (Bun 1.4.4). No PostgreSQL or heavy suites.

## Comments
