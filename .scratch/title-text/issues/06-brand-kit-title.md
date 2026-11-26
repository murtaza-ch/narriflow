# 06 - Brand kit: Title section on the template form

**What to build:** A brand template's form has a Title section: on/off switch, display duration, and the title style with a live sample.

**Blocked by:** [04 - Text panel, timeline lane, Apply to all clips](04-text-panel-timeline.md), [05 - Auto title and persistence](05-auto-title-and-persistence.md)

**Status:** ready-for-agent

Read `../spec.md` section 7 and `apps/web/app/(app)/brand-kit/_components/template-form.tsx`.

## Scope

- Title section next to the caption style section, clearly labelled apart from it: switch "Add the clip title to new clips", display duration (3 s, 5 s, 10 s, whole clip, custom seconds), `TextStyleControls`, position (top, middle, bottom as a simple choice mapped to `positionY`), and a live sample drawn by the real painter on the form's preview frame.
- Switching the title off keeps its style and duration. A template without `title` shows the built-in default.
- Saved through the existing template create and update mutations.

## Acceptance

- [ ] Saving a template with a changed title style, reloading the form, shows the saved style.
- [ ] A project created with that template seeds titles in that style (covered by ticket 05 tests; check the wiring by reading).
- [ ] `bun run lint`, `bun run typecheck`, `bun run test`, `bun run check:web-split` pass.
