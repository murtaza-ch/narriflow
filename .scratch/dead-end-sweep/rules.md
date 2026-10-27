# Dead-end sweep — rules (2026-10-27)

The owner hit greyed-out buttons on the Creator plan (Automation grants "New grant", Dubbing "Generate dub")
and asked to review and fix every similar case across Narriflow. Goal: **no dead ends**. Every control a user
can see either works, or says why not and offers the next step.

Classify each blocked control by its real cause (read the server/service check — never guess) and apply:

| Cause | Treatment |
| --- | --- |
| Plan lacks the feature / count limit, and a higher plan lifts it | Keep the action visible; `LockedButton` (gem, opens the shared upgrade dialog) or `useUpgrade().openUpgrade(prompt)` / `PlanLimitNotice` with `upgrade`. Build prompts with catalog helpers: `featureUpgradePrompt` (`apps/web/lib/feature-upgrade-prompt.ts`), `planFeatureRequirement`/`planCountRequirement`/`planUpgradeHighlight` (`packages/validators/src/pricing.ts`). Never a bare tier comparison. |
| Plan limit no plan lifts (top tier, monthly allowance) | Disabled is OK, with a visible reason and what to do (delete/pause/wait for renewal date). No Upgrade. |
| Role (viewer/editor/admin not allowed) | Hide the action, or show it disabled with visible text "Ask a workspace owner/admin …". Never an upgrade offer. Purchases are owner-only (`useUpgrade().canManageBilling`). |
| Workspace status pending_payment / restricted | Explain; owners get a link to `/settings/billing`; others are told to ask the owner. |
| Missing prerequisite (no rule, no rendered clip/export, no connected account, no transcript yet, nothing selected) | Turn it into the path to the prerequisite (link/button to where it's created) or show adjacent text naming the prerequisite. A disabled button whose only explanation is a `title` tooltip doesn't count (invisible on touch). Selection prerequisites ("select a clip") may stay disabled if the UI makes the need obvious. |
| Provider/config unavailable, rollout | "Temporarily unavailable" text; no upgrade. |
| In-flight / busy | Disabled while pending is fine. |

Also fix: empty states with no next action; menus/items that silently do nothing; upgrade offers that name a plan
that wouldn't actually admit the action (mirror the server check); copy that contradicts the plan catalog.

Constraints:
- UI-level fixes only. Do not change server enforcement unless a server check is plainly broken (report it).
- Reuse `apps/web/app/(app)/_components/upgrade.tsx` and `plan-limit-notice.tsx` as-is; don't edit them (report needs).
- Match surrounding style; owner taste: no borders, soft fills, quiet, short copy, no walls of text.
- Plan catalog: Free / Creator / Pro / Business in `packages/validators/src/pricing.ts`.
- Other agents edit in parallel — stay in your owned paths; re-read files before editing. Don't commit.
- Verify: focused tests, `bun run lint`, `bun run typecheck`, `bun run test` (from repo root). Update/add tests for
  changed behaviour (render tests with existing patterns).
- Report: a table of every case found (file:line, cause, before → after), anything you deliberately left, and
  server-side issues you noticed.
