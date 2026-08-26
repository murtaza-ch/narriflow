# Expand transitions and media motion

**What to build:** Route current transitions through the Clip Composition Plan, then add the approved transition and media-motion vocabulary with browser and FFmpeg parity.

**Blocked by:** [Version the Clip Editor Document for new timed edits](version-the-editor-document-for-new-timed-edits.md) and [Add reusable and insertable Scene Blocks](add-reusable-and-insertable-scene-blocks.md).

**Status:** ready-for-agent

**Specification:** [Motion and media animation](../features/motion-and-animation.md)

## Observable acceptance criteria

- [ ] Current Cut, Fade, Fade to Black, and Dip White resolve through the shared plan without visible regression.
- [ ] Cross Dissolve, directional wipe, directional slide, and zoom transitions use canonical timing and geometry.
- [ ] Fade, scale, pan, and Ken Burns entrance or exit apply to Scene Blocks, manual B-roll, and text cards.
- [ ] The planner owns conflicts, clamping, precedence, target geometry, and typed fallback notices.
- [ ] Reduced-motion preview displays a static state without changing saved or rendered motion.
- [ ] Eligible motion can be applied through Campaign Operations while current Studio apply-to-all remains.

## Tests and failure injection

- [ ] Shared fixtures cover every motion, direction, target, short interval, exact boundary, B-roll precedence, scene conflict, and fallback.
- [ ] Real-media tests compare representative frames and probes across preview and export.
- [ ] Performance tests enforce simultaneous-layer, plan-size, filter-branch, memory, and target-count budgets.
- [ ] Unknown versions fail before preview adoption or command execution.

## Rollout

- [ ] Shadow current transitions, then enable new families one at a time in the order defined by the feature spec.

## Scope boundaries

- [ ] Do not add keyframes, arbitrary easing, custom paths, or generated motion graphics.

## Fresh-task handoff

Implement with `/tdd`, finish with `/code-review`, and run composition, adapter, worker, performance, browser, real-media, typecheck, and repository tests.

