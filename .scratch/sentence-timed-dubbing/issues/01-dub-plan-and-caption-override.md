# 01 - Dub segment plan and caption override

**What to build:** The pure building blocks shared by admission and render: `planDubSegments` (spec §1) in `packages/validators/src/dub-plan.ts`, and the `captionOverride` input of `planClipComposition` / `deriveCaptionCues` with override-driven ducking windows (spec §5, first two bullets) in `packages/composition-plan/src/clip-composition-plan.ts`.

**Blocked by:** None

**Status:** done

## Acceptance
- [x] `planDubSegments(document)` implements every rule in spec §1, exported from validators (index + package export path if the package uses explicit exports).
- [x] Unit tests: silence cuts and filler cuts inside and between sentences drop exactly the words captions drop; zero-duration tokens; untimed utterance fully kept / fully cut / partially cut (refusal); overlapping speakers merge; short-segment merge both directions; punctuation-only segments dropped; empty and >160 refusals; edited times match `sourceWordToEdited`.
- [x] `captionOverride: { language: string; segments: { text: string; spaceBefore?: boolean; startSec: number; endSec: number }[][] }` (edited time) on the plan input; captions built from it group per segment with `groupCaptionTokens(preset.wordsPerCue)`, keep preset/anchor/text transform (override language)/emoji/scene retiming, ignore censor masks, and respect `preset.visible === false` like today. Included in the plan input fingerprint.
- [x] `deriveCaptionCues(document, { captionOverride })` uses the same path.
- [x] `buildAudioSchedule` ducking windows come from override words when present.
- [x] Tests for override grouping, scene-block retiming, fingerprint change, ducking windows.
- [x] `bun run lint`, `bun run typecheck`, `bun run test` pass.

## Comments

- 2026-11-19: Done. `planDubSegments` in `packages/validators/src/dub-plan.ts` (exported from the validators index; the package's `.` export covers it), `captionOverride` in `packages/composition-plan/src/clip-composition-plan.ts`. New tests: `packages/validators/src/dub-plan.test.ts` (24) and `packages/composition-plan/src/caption-override.test.ts` (10). `bun run lint` (0 errors, 20 existing warnings), `bun run typecheck` (15/15 tasks) and `bun run test` (14/14 tasks; validators 791 pass, composition-plan 99 pass, media 887 pass) are green.
- Deviation worth knowing: an untimed utterance that overhangs the clip window is clamped to the window before the kept-or-cut check, so window overhang is not read as a partial cut.
