# 10 — Add suggestion-first Auto Censor

**What to build:** Detect timed sensitive-word suggestions, let the editor review them, and apply caption mask, beep, or mute through one Clip Editor Document and shared audio plan.

**Blocked by:** [Migrate Brand Kit with Brand Template compatibility](03-migrate-brand-kit-with-template-compatibility.md), [Extend entitlements, permissions, and program analytics](02-extend-entitlements-permissions-and-program-analytics.md), and [Version the Clip Editor Document for new timed edits](05-version-the-editor-document-for-new-timed-edits.md).

**Status:** done

**Specification:** [Suggestion-first auto-censor](../features/auto-censor.md)

## Observable acceptance criteria

- [x] A pure versioned detector combines built-in locale policy, Brand Profile blocked terms, and project terms over corrected timed transcript words.
- [x] Scanning is read-only and returns stable suggestion fingerprints with word IDs, timing, policy source, and treatment.
- [x] Studio reviews, filters, includes, excludes, and changes treatments before apply.
- [x] Apply creates one undo entry with individually editable Censor Segments.
- [x] Caption masking uses the shared cue model and leaves transcript text unchanged.
- [x] Mute and beep use the shared edited-time audio schedule and normalize overlap deterministically.
- [x] Preview and FFmpeg consume the same interval and envelope helpers.

## Tests and failure injection

- [x] Tests cover Unicode, case, phrases, punctuation, untimed words, corrected words, stale suggestions, deleted ranges, trim, exact end, overlap, and empty results.
- [x] Audio fixtures verify beep frequency, level, fades, mute precedence, music preservation, and no clipping.
- [x] Studio tests cover undo, redo, recovery, conflict, entitlement preview, and apply.
- [x] Logs and analytics tests prove matched words and context never leave the domain response.

## Rollout

- [x] Implement and locally prove fail-closed stages for scans first, caption masks second, mute third, and beep last after real-media comparison. Deployment rollout remains governed by the program cutover runbook.

## Scope boundaries

- [x] Do not add object blur, transcript rewriting, contextual LLM auto-apply, or live censoring.

## Fresh-task handoff

Implement with `/tdd`, finish with `/code-review`, and run detector, editor, caption, audio, worker, real-media, typecheck, and repository tests.
