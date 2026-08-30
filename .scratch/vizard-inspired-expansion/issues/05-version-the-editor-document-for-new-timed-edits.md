# 05 — Version the Clip Editor Document for new timed edits

**What to build:** Add empty-by-default Scene Block, Censor Segment, and media-motion document families plus migration and Studio Editing Session support, without enabling new editing UI.

**Blocked by:** [Move timed visual layers into the shared plan](../../clip-composition-plan/issues/07-move-timed-visual-layers-into-plan.md) and [Plan the edited-time audio schedule end to end](../../clip-composition-plan/issues/08-plan-edited-time-audio-schedule.md).

**Status:** done

**Specifications:** [Scene blocks](../features/scene-blocks.md), [Suggestion-first auto-censor](../features/auto-censor.md), [Motion and media animation](../features/motion-and-animation.md)

## Observable acceptance criteria

- [x] The next document version defines bounded, strict schemas for Scene Blocks, Censor Segments, and media motion.
- [x] Pre-production documents are reset to the current v2 shape; obsolete and unknown versions fail closed before mutation, preview adoption, or export.
- [x] Unknown newer versions fail safely before mutation, preview adoption, or export.
- [x] The reducer supports insert, update, remove, move, duplicate, enable, and disable intents needed by the three feature plans.
- [x] Studio Editing Session includes all new fields in history, Device Draft durability, cloud checkpoints, convergence, reset, and export preparation.
- [x] Document size, item count, finite timing, ID uniqueness, reference kind, and nesting bounds are enforced.

## Tests and failure injection

- [x] Migration fixtures cover the current version while malformed, obsolete, and future documents fail closed.
- [x] Reducer tests cover undo, redo, continuous gestures, deleted ranges, trim, duplicate IDs, exact end, and no-op edits.
- [x] Session tests cover offline recovery, stale cloud response, multi-tab takeover, conflict choice, and export barrier with new fields.
- [x] Current documents with empty new fields preview and render unchanged.

## Migration and rollout

- [x] Ship the strict v2 reader and reset pre-production drafts before enabling writers.
- [x] Keep new intents unreachable until their feature ticket enables them.

## Scope boundaries

- [x] Do not build Scene, Censor, Motion, or Generate panels in this foundational ticket.
- [x] Do not add an operation-log or collaborative editor protocol.

## Fresh-task handoff

Implement with `/tdd`, finish with `/code-review`, and run editor-document, Studio Editing Session, composition-plan, typecheck, and repository tests.
