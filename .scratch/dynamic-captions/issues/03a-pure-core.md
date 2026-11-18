# 03a - Pure core

**What to build:** The plan carries Caption Blocks for dynamic presets, with shared geometry and motion data (spec 5.2 to 5.8).

**Blocked by:** 00, 01, 02

**Status:** ready-for-agent

Spec: [../spec.md](../spec.md). Follow the spec; where a ticket and the spec disagree, the spec wins.

## Acceptance

- [ ] Preset fields (5.2), `caption-dynamic.ts` with Headline, soft cue breaks for every preset (5.4), roles as a second pass, `block` on caption layers including the dub `captionOverride` path (5.5), `captionCueBlock`.
- [ ] `packages/caption-fonts/src/caption-block.ts` exported as `@narriflow/caption-fonts/caption-block` (no `node:` imports) implementing 5.6 rules 1 to 10.
- [ ] `CaptionKeyframe.offsetXEm/rotateZDeg`, `CaptionMotionSpec.hero`, `slide`; `caption-style.test.ts` keeps enforcing libass limits.
- [ ] Emoji nulled for dynamic presets; subtitles and the clip timeline read `words[].text`.
- [ ] `GLOSSARY.md` terms (5.1) and an ADR for decisions 1 and 2 (`docs/adr/`).
- [ ] Unit tests for rows, geometry rules, duration cap, seeds; `caption-preset.test.ts` updated for the new group.
- [ ] `bun run lint`, `bun run typecheck`, `bun run test` pass (Bun 1.4.4). No PostgreSQL or heavy suites.

## Comments
