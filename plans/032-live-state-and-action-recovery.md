# Plan 032: Keep project state fresh and recover every render/download action

> **Executor instructions**: Follow the plan, run every gate, and touch only
> scoped files. Work directly in the shared current tree; do not stage, commit,
> push, or edit the plan index. Stop on stated conditions.
>
> **Drift check**:
> `git diff --stat 05d273d..HEAD -- 'apps/web/app/(app)/projects/[projectId]/project-events.tsx' 'apps/web/app/(app)/projects/[projectId]/page.tsx' 'apps/web/app/(app)/projects/[projectId]/clip-card.tsx' 'apps/web/app/(app)/projects/[projectId]/dubbing-panel.tsx' apps/web/lib/project-state.ts`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plan 022
- **Category**: bug, ux, tests
- **Planned at**: commit `05d273d`, 2026-07-09, live working tree
- **Result**: DONE — reviewed 2026-07-10; 15/15 focused tests and
  scoped Biome passed, executor full lint/typecheck/tests/build passed, and the
  authenticated project workspace rendered correctly in the in-app browser.

## Why this matters

SSE terminal refreshes are deduplicated by stage name forever, so the second
detect/render/publish run can complete while the page remains stale. Detection,
all-failed renders, and failed posts are rendered as “todo” even though the
snapshot already contains failure state. Render/download requests also have
transport paths that leave optimistic pending UI stuck or make clicks appear to
do nothing.

## Scope

Only modify/create:

- `apps/web/app/(app)/projects/[projectId]/project-events.tsx`
- `apps/web/app/(app)/projects/[projectId]/page.tsx`
- `apps/web/app/(app)/projects/[projectId]/clip-card.tsx`
- `apps/web/app/(app)/projects/[projectId]/dubbing-panel.tsx`
- `apps/web/lib/project-state.ts` (create if useful)
- `apps/web/lib/project-state.test.ts` (create if useful)

Out of scope: changing workflow backend states, retries with external side
effects, social post-now/schedule semantics, or new component-test tooling.

## Steps

1. Parse SSE payloads with the shared workflow event schema. Dedupe event rows
   by seq and terminal refreshes by terminal event identity/run+seq—not stage.
   Bound both sets, reset them on project change, and cover two completed runs
   of the same stage with a pure helper test. Malformed events must not crash
   the panel; ignore/log a stable code.
2. Derive pipeline state with explicit precedence: success, active, failed,
   todo. Detection uses the latest run; render uses variant outcomes (some asset
   = done, pending/rendering = active, all requested failed = failed); publish
   uses posted, scheduled/publishing, and failed outcomes. Add pure table tests.
3. Wrap render queue, preview/download, and dub download transport paths in
   `try/catch/finally`. Clear optimistic pending state on every failure, validate
   HTTP/payload, show mapped `role=alert` copy, and navigate/download through a
   popup-safe location/anchor flow. Never auto-retry a mutation.
4. Run `bun run lint:biome`, `bun run typecheck`, `bun run test`, and
   `bun run build`; all pass. Verify only scoped files changed.

## Done criteria

- [x] Two terminal runs of the same stage each refresh once.
- [x] Malformed/replayed SSE messages cannot crash or refresh-loop.
- [x] Failed detection/render/publish appears failed, not todo.
- [x] Network rejection never leaves render/dub UI permanently pending.
- [x] Download failure is visible; successful navigation is popup-safe.
- [x] Pure tests and all release gates pass.

## STOP conditions

- Correct state requires a backend response-shape or schema change.
- A fix would automatically retry an externally consequential action.
- Component testing requires installing a new framework.
- A gate fails twice after one reasonable correction.
