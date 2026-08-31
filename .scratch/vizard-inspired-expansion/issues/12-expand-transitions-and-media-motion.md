# 12 — Expand transitions and media motion

**What to build:** Route current transitions through the Clip Composition Plan, then add the approved transition and media-motion vocabulary with browser and FFmpeg parity.

**Blocked by:** [Version the Clip Editor Document for new timed edits](05-version-the-editor-document-for-new-timed-edits.md) and [Add reusable and insertable Scene Blocks](08-add-reusable-and-insertable-scene-blocks.md).

**Status:** done

**Specification:** [Motion and media animation](../features/motion-and-animation.md)

## Observable acceptance criteria

- [x] Current Cut, Fade, Fade to Black, and Dip White resolve through the shared plan without visible regression.
- [x] Cross Dissolve, directional wipe, directional slide, and zoom transitions use canonical timing and geometry.
- [x] Fade, scale, pan, and Ken Burns entrance or exit apply to Scene Blocks, manual B-roll, and text cards.
- [x] The planner owns conflicts, clamping, precedence, target geometry, and typed fallback notices.
- [x] Reduced-motion preview displays a static state without changing saved or rendered motion.
- [x] Eligible motion can be applied through Campaign Operations while current Studio apply-to-all remains.

## Tests and failure injection

- [x] Shared fixtures cover every motion, direction, target, short interval, exact boundary, B-roll precedence, scene conflict, and fallback.
- [x] Real-media tests compare representative frames and probes across preview and export.
- [x] Performance tests enforce simultaneous-layer, plan-size, filter-branch, memory, and target-count budgets.
- [x] Unknown versions fail before preview adoption or command execution.

## Rollout

- [x] Implement and locally prove ordered controls that shadow current transitions, then release Cross Dissolve, wipe, slide, zoom, media fade/scale, pan/Ken Burns, and selection-scoped apply one stage at a time. Deployment rollout remains governed by the program cutover runbook.

## Scope boundaries

- [x] Do not add keyframes, arbitrary easing, custom paths, or generated motion graphics.

## Fresh-task handoff

Implement with `/tdd`, finish with `/code-review`, and run composition, adapter, worker, performance, browser, real-media, typecheck, and repository tests.
