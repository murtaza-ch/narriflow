# Version the Clip Editor Document for new timed edits

**What to build:** Add empty-by-default Scene Block, Censor Segment, and media-motion document families plus migration and Studio Editing Session support, without enabling new editing UI.

**Blocked by:** [Move timed visual layers into the shared plan](../../clip-composition-plan/issues/07-move-timed-visual-layers-into-plan.md) and [Plan the edited-time audio schedule end to end](../../clip-composition-plan/issues/08-plan-edited-time-audio-schedule.md).

**Status:** ready-for-agent

**Specifications:** [Scene blocks](../features/scene-blocks.md), [Suggestion-first auto-censor](../features/auto-censor.md), [Motion and media animation](../features/motion-and-animation.md)

## Observable acceptance criteria

- [ ] The next document version defines bounded, strict schemas for Scene Blocks, Censor Segments, and media motion.
- [ ] Known older documents upgrade deterministically with empty values and preserve their current fingerprint semantics where no new edit exists.
- [ ] Unknown newer versions fail safely before mutation, preview adoption, or export.
- [ ] The reducer supports insert, update, remove, move, duplicate, enable, and disable intents needed by the three feature plans.
- [ ] Studio Editing Session includes all new fields in history, Device Draft durability, cloud checkpoints, convergence, reset, and export preparation.
- [ ] Document size, item count, finite timing, ID uniqueness, reference kind, and nesting bounds are enforced.

## Tests and failure injection

- [ ] Migration fixtures cover every historical supported version and malformed or future documents.
- [ ] Reducer tests cover undo, redo, continuous gestures, deleted ranges, trim, duplicate IDs, exact end, and no-op edits.
- [ ] Session tests cover offline recovery, stale cloud response, multi-tab takeover, conflict choice, and export barrier with new fields.
- [ ] Existing documents with empty new fields preview and render unchanged.

## Migration and rollout

- [ ] Ship readers and local-draft upgrade before writers.
- [ ] Keep new intents unreachable until their feature ticket enables them.

## Scope boundaries

- [ ] Do not build Scene, Censor, Motion, or Generate panels.
- [ ] Do not add an operation-log or collaborative editor protocol.

## Fresh-task handoff

Implement with `/tdd`, finish with `/code-review`, and run editor-document, Studio Editing Session, composition-plan, typecheck, and repository tests.

