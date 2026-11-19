# 09b - Behind-speaker front fallback placement

**What to build:** A behind cue that cannot clear the head no longer draws a huge word across the face: its block moves to the lower third at a capped size. Depth's support words grow. Orchestrator calls from the ticket 09 evidence (`.scratch/dynamic-captions/out/09/contact-sheet.jpg`, 2026-11-19).

**Blocked by:** 09 (done).

**Status:** dropped

Spec: [../spec.md](../spec.md). Update 5.12 "Auto-placement above the head" and the Depth catalog entry to match.

## Changes

1. Front fallback: when the placement rule puts a behind cue's hero in front, that cue is laid out in "front fallback" mode: hero size capped at 2.6 S (after fill), block anchored at y 70% (the style's own x), safe area as usual. Decided in shared code (`caption-block.ts`), so both renderers agree; it uses the same decision the placement rule already returns. Test: fallback cue sits in the lower third and its hero is at most 2.6 S.
2. Depth: support size S 52 → 64 (hero clamps unchanged in em, re-check rule 1 and fit). Small support words like "the process" were unreadable next to a 5 S hero.
3. Re-render the ticket 09 evidence clips (`.scratch/dynamic-captions/out/09/`, scripts in `out/09/scripts/`) and a new contact sheet `out/09b/contact-sheet.jpg`.

## Acceptance

- [ ] Changes 1–3 with tests; spec updated; fixtures/snapshots/docs frame regenerated where values changed.
- [ ] `bun run lint`, `bun run typecheck`, `bun run test` pass. No PostgreSQL or heavy suites.

## Comments

### Dropped (orchestrator, 2026-11-19)

Dropped with ticket 09 (owner removed text behind the speaker).
