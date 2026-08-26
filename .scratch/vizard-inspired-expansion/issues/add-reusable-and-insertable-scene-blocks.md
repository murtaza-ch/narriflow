# Add reusable and insertable Scene Blocks

**What to build:** Deliver single-clip Scene Block editing, reusable Scene Templates, and preview/export parity through the existing Studio and Clip Composition Plan.

**Blocked by:** [Establish Brand Profile and Visual Asset ownership](establish-brand-profile-and-visual-asset-ownership.md), [Migrate Brand Kit with Brand Template compatibility](migrate-brand-kit-with-template-compatibility.md), and [Version the Clip Editor Document for new timed edits](version-the-editor-document-for-new-timed-edits.md).

**Status:** ready-for-agent

**Specifications:** [Program map](../spec.md), [Reusable and insertable scene blocks](../features/scene-blocks.md)

## Observable acceptance criteria

- [ ] Studio inserts video, image, color, and text-card blocks at start, end, playhead, and transcript boundaries.
- [ ] Move, trim, duplicate, replace, delete, undo, redo, recovery, cloud save, and export use Studio Editing Session intents.
- [ ] The Clip Composition Plan produces one contiguous edited timeline with canonical visual and audio behavior for inserted blocks.
- [ ] Browser and FFmpeg adapters consume the same scene plan for every supported target.
- [ ] Brand Kit saves and applies frozen Scene Templates, including default intro and outro roles.
- [ ] Applying a template copies its definition and does not subscribe the clip to later template edits.

## Tests and failure injection

- [ ] Pure tests cover anchor remapping, source and edited time, duration bounds, deleted ranges, exact end, and idempotent template application.
- [ ] Adapter and real-media tests cover all scene kinds, fit treatments, own audio, font fallback, missing assets, and four targets.
- [ ] Browser checks cover timeline and transcript insertion, playback preservation, keyboard operation, and Blueline Inspector layout.

## Migration and rollout

- [ ] Shadow empty-document plans first, then enable cards, images, uploaded video, and templates in that order.
- [ ] Each stage has an independent write control and rollback to read-only display.

## Scope boundaries

- [ ] Do not add overlapping tracks, nesting, arbitrary layers, or automatic scene generation.

## Fresh-task handoff

Implement with `/tdd`, finish with `/code-review`, and run document, composition, Studio, worker, real-media, browser, typecheck, and repository tests.

