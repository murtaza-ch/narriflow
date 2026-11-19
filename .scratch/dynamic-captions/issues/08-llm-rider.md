# 08 - Llm rider

**What to build:** Only if G1 failed: emphasis words from the clip selection call feed the scorer (spec 5.13).

**Blocked by:** 01

**Status:** done

Spec: [../spec.md](../spec.md). Follow the spec; where a ticket and the spec disagree, the spec wins.

## Acceptance

- [x] Built only if G1 recorded a failure after one tuning round; otherwise mark `done` with "not needed" and the G1 numbers.
- [x] Schema, prompt, persistence migration, scorer bonus, critical-path review of the selection contract.
- [x] `bun run lint`, `bun run typecheck`, `bun run test` pass (Bun 1.4.4). No PostgreSQL or heavy suites.

## Comments

G1 failed for native script after one tuning round (72.6% held-out, bar 80%); see ticket 01. This ticket is needed.

### 2026-11-19, built (ticket 08 agent)

What shipped:

- Selection call: `emphasis_words` (array of up to 8 strings, required in `CLIP_DETECTION_JSON_SCHEMA`, `maxItems` 8, each 1 to 40 characters) and a prompt paragraph that says to copy each word or 2-word unit exactly from the clip's own transcript, in its script, never translated. The response schema hash and `SYSTEM_PROMPT` change, so a window frozen under the old capsule is refused (`clip-selection-control.test.ts`, new) before it reaches the provider; the control and `execution-selection-restore.ts` already compare both against the current constants, so no code change was needed there.
- `clipEmphasisWords` (validators): trims, drops anything over 2 words or 40 characters, drops duplicates, and keeps only words found in the clip's final transcript slice by the scorer's normalisation (a 2-word unit must be adjacent in one utterance). The check runs in `buildDetectedClipRows` against the final slice, because the clip's timing is refined after the model answers.
- `Clip.emphasisWords Json?` and migration `20261119180000_clip_emphasis_words` (one nullable column); `apps/api/src/generated/database-migrations.json` regenerated. The column is part of the editor document (`emphasisWords`, optional), written only at clip creation. Editor `replace` and `reset` keep the stored value whatever the client sends. Export freezes it in the clip snapshot. Duplicating a clip carries it.
- Scorer: `CAPTION_EMPHASIS_WEIGHTS.llm = 3.0`, matched on the scorer's normalised text for single words and for adjacent 2-word units (the unit scores as its better word plus 3.0, counted once). A minor or filler suggestion still cannot be the hero. The plan passes `document.emphasisWords` to `assignCaptionRoles` for source captions only; dub captions pass none. No words, or none matching, scores exactly as before.
- GLOSSARY: added "Clip Emphasis Words".

Open for the render path (not this ticket's files): `apps/media/src/render-group.ts` line 46 builds the frozen `clip` from named document fields and does not copy `emphasisWords`, so a Modal render would not see them while Studio and the plan do. One line: `...(doc.emphasisWords ? { emphasisWords: doc.emphasisWords } : {})`. Owner of `apps/media/**` (ticket 03b) applies it.

Checks (Bun 1.4.4): `bun run lint` exit 0 (20 warnings, none in these files); `bun run typecheck` 15/15; `bun run test` 14/14 tasks (validators 889, services 1629, composition-plan 127, api 984, web 1140, media 1015, 0 fail); `apps/api test:inventory` 0 problems; `openapi:check` matches; `migrations:check` passes.
