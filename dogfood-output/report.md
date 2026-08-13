# Dogfood Report: Narriflow

| Field | Value |
|-------|-------|
| **Date** | 2026-08-13 |
| **App URL** | http://localhost:3000/home |
| **Session** | Real authenticated Chrome session through the Codex extension |
| **Viewport coverage** | Desktop plus 390×844 mobile |
| **Scope** | React 19 / Next.js 16.3 upgrade and recommended-plan regression verification |

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 1 |
| **Total** | **1** |

The authenticated application is operational across the tested critical read paths. No blocking UI, route failure, React exception, or destructive-action regression was observed.

## Coverage

- Home loaded the signed-in workspace and recent projects.
- Projects loaded all 10 records; search, failed-status empty state, clear filters, RSS source filter, title sorting, and grid/list mode all worked.
- A real project detail loaded 10 clips and its destructive confirmation opened as an `alertdialog`; Cancel closed it without changing data.
- Workspace settings loaded the existing workspace name, timezone combobox, and save action without submitting changes.
- Exports loaded four ready deliveries.
- Calendar loaded the August 2026 empty state and publishing filters.
- Autopilot loaded its empty state and creation actions.
- Brand kit loaded the user template and built-in templates.
- Mobile Home and Projects rendered at 390×844; the mobile menu opened and navigated to Projects.
- Browser diagnostics showed no application-origin runtime errors.

## Verification commands

- `bun run typecheck` — 10/10 tasks passed.
- `bun run test` — 10/10 tasks passed; web package 262 tests passed, 0 failed.
- `bun run lint` — 10/10 tasks passed (most package lint scripts are currently no-op).
- `bun run build` — Next.js 16.3.0 production build passed; 46 static pages generated.

## Issues

### ISSUE-001 — Above-the-fold project image is not prioritized

**Severity:** Low

**Area:** Home / performance

**Evidence:** Browser console warning on `http://localhost:3000/home`; see [desktop Home screenshot](./screenshots/home-desktop.png) and [mobile Home screenshot](./screenshots/home-mobile.png).

Next.js reports that `https://i.ytimg.com/vi/mlQfcbaZVJY/maxresdefault.jpg` became the Largest Contentful Paint image and recommends loading it eagerly. This can delay perceived rendering of the first recent-project card.

**Recommended fix:** Mark only the first visible project thumbnail as eager/high priority (`loading="eager"` or the current Next.js Image priority/preload pattern), while preserving lazy loading for the remaining cards.

## Non-app diagnostics

- Grammarly injected `Identifier 'AssistantLoadState' has already been declared`; the error originates from the Grammarly Chrome extension, not Narriflow.
- Clerk warned that development keys are active; expected for this local environment.
- Turborepo warned that several build/test tasks do not declare output files; this did not affect command success.

## Artifacts

- [Desktop Home](./screenshots/home-desktop.png)
- [Desktop Projects](./screenshots/projects-desktop.png)
- [Mobile Home](./screenshots/home-mobile.png)
- [Mobile Projects](./screenshots/projects-mobile.png)
