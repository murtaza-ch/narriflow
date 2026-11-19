# 06b - Catalog polish from the visual review

**What to build:** The five phase 1 styles separate clearly from each other and match their references more closely, and cues stop ending on a stray function word. From the Opus visual review of the 05b sheets (2026-11-19) with the orchestrator's calls.

**Blocked by:** 06 (it edits the same catalog and font files).

**Status:** ready-for-agent

Spec: [../spec.md](../spec.md). Update the spec's section 6 catalog rows and 5.4 to match what ships.

## Changes

1. **Cue breaks, every preset (spec 5.4).** A cue never ends on a minor (closed-class) word when the next token is in the same sentence: that word moves to the start of the next cue. Use the emphasis word lists' minor classification by language (no roles needed). Example: "week of content in / one hour" becomes "week of content / in one hour". Tests in `caption-cues.test.ts` and the plan. Subtitle files follow, as they read the same layers.
2. **Headline.** `rowGapEm` 0.06 → 0.04. Heroes in all caps (every cased letter upper) cap at 3.0 S instead of 3.4 S (a shared geometry rule driven by a style field, e.g. `heroFill.maxEmCaps`).
3. **Stack.** Support words in a light face: vendor Inter Regular (OFL, official Google Fonts / rsms Inter static file, same procedure as the other faces) and use it for Stack's text slot; keep S 64 and the 2.4 S hero. Check with an ink mask that the "i" dot of "captions" does not touch the row above; raise `rowGapEm` to 0.06 if it does.
4. **Marker.** Support words to Inter SemiBold at about 52 px (hero stays Poppins ExtraBold lowercase), so the pair follows section 6 rule 2.
5. **Editorial.** `staggerEm` about 0.6 (rows visibly offset, alternating by seed); minor sans 52 px in white `#FFFFFF`; body serif 68 px; hero unchanged. Check legibility on the bright frame.
6. **Cutout.** Anton instead of Bebas Neue, S about 110 so a 5-word row spans about 80% of the frame (the fit clamp handles long words); pink tiles only for words of 1–2 letters (tile colour by letter count, not by minor role); the `drop` word track compressed to 0–90 ms (rule 6). Re-check the tilt reads at the new size.

Render contact sheets for all six styles (worker vs Studio, three backgrounds, entrance moments, references) into `scratchpad/06b/` and record final values in the ticket.

Not taken from the review: a karaoke highlight on the spoken word. Dynamic styles already reveal each word as it is spoken, and the classic Karaoke preset exists.

## Acceptance

- [ ] Changes 1 to 6 with tests; spec updated; fixtures, snapshots, REST/OpenAPI and docs frames regenerated where values changed.
- [ ] `bun run lint`, `bun run typecheck`, `bun run test`, `bun run check:web-split`, `bun run --cwd apps/api openapi:check` pass. No PostgreSQL or heavy suites.

## Comments
