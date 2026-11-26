# 05 - Remembered chrome slot sizes

**What to build:** For a returning person on any plan or role, the pending top bar and sidebar reserve the same space as the last ready render, so nothing moves when the Workspace opens. The space reserved is the last ready render's: the gold Upgrade in the credits pill, a long balance, a locked Invite's gem, no Invite, no "New project".

**Blocked by:** [02 - Chrome renders pending](02-chrome-renders-pending.md)

**Status:** done

Spec: [../spec.md](../spec.md). Files: `apps/web/lib/chrome-layout-hint.ts` (+ test), `apps/web/app/layout.tsx`, `apps/web/app/(app)/_components/{app-chrome,credits-menu,sidebar,mobile-nav,app-shell.browser.fixture}.tsx`.

## Behaviour

1. When the chrome is ready, measure the real controls and store only layout numbers under one localStorage key (`narriflow-chrome-layout`): `{ balance, upgrade, invite, newProject }`, widths in CSS px and a boolean. Write only when a value changed. A slot that is not laid out (the desktop bar on a phone, a page with no pill) keeps its last value.
2. The root layout's `beforeInteractive` inline script reads the key before the first paint, validates each field on its own (finite, 0 to a per-field maximum; `newProject` boolean) and sets custom properties on `<html>`. Anything else is ignored.
3. The placeholders read those properties, with today's sizes as fallbacks. Nothing reads storage during render, so the server HTML and the first client render are unchanged.
4. The ready controls keep their natural size: a stale hint costs at most the one-time shift there is without one.

## Acceptance

- [x] A test proves the placeholders read the custom properties and fall back without them.
- [x] The inline script ignores malformed stored values.
- [x] Nothing sensitive is stored (the stored shape is asserted).
- [x] The server render equals the first client render with no hydration warning (existing five-route case).
- [ ] In a browser: for an owner below Business, a viewer and a five-digit balance, a second hard load moves nothing in the top bar or sidebar.

## Comments

2026-11-26 (implementer). Design: `lib/chrome-layout-hint.ts` owns the key, the custom property names, the before-paint script (`CHROME_LAYOUT_SCRIPT`, appended to the existing theme script in `app/layout.tsx`), and the measure-and-write step. `AppChrome` calls `rememberChromeLayout` after each ready render and each route change (settings and an open Project show no pill). It waits for `document.fonts.ready` and one frame, then measures. Storage errors are swallowed.

What is stored and why:
- `balance`: width of the real balance box only, not the whole trigger. The trigger's "credits" label shows only at `xl`, so a trigger width measured at one breakpoint would be wrong at the other. The balance box is the same at both. The placeholder's balance box takes it as `min-width` (fallback `0px`, so the hidden "0,000" still sets the floor).
- `upgrade`: the pill's width minus the trigger and the pill's padding, which is the Upgrade button plus its 4px gap (0 when absent). The placeholder pill gets a spacer of that width with a bone inset by the gap.
- `invite`: the Invite slot's width on the default top bar only (`data-chrome-top-bar`; the upload funnel has no Invite slot). 0 when absent, and then the script also sets `--nf-chrome-invite-display: none`, which removes the placeholder and its flex gap.
- `newProject`: comes from the same rule the sidebar uses (`canCreateProjects`), not from the DOM. When false, `--nf-chrome-new-project-display: none` hides the "New project" bone in the sidebar and the mobile drawer.

Slots covered: the default shell's top bar (balance, Upgrade, Invite), the upload funnel's top bar (balance, Upgrade), the sidebar's and the mobile drawer's "New project". The mobile drawer's credits meter is right-aligned with a fixed bone, so it needs nothing. The hint is per browser, not per user or Workspace: after switching between Workspaces on different plans, the first hard load uses the last one's sizes (one shift at most, as today).

Verified: `lib/chrome-layout-hint.test.ts` (7 cases): the script sets the expected properties and ignores missing, non-JSON, non-object, negative, out-of-range, string, `1e400` and blocked-storage values field by field; the stored hint has exactly `balance, invite, newProject, upgrade`, drops foreign stored fields (`name`, `workspaceId`), is rewritten only on change, keeps unseen slots and never throws when storage refuses; measurement with stubbed rects gives Upgrade + gap, zero for an absent Invite, and leaves out slots that are not laid out. App-shell fixture case "the pending chrome takes the remembered slot sizes before the first paint, and today's without them" mounts the real pending chrome, checks computed styles of the New project, Invite, balance and Upgrade placeholders with no hint, then runs the real script against a stored hint and checks them again. Mutation: replacing the balance placeholder's `chromeVar` with `0px` fails it. The five-route server-render and hydration case passes unchanged.

Not ticked: the browser box. happy-dom has no layout, so the measured widths (and whether they equal the placeholders' boxes to the pixel) are untested. Needs the orchestrator's browser check: an owner on Free/Pro (Upgrade + locked-Invite gem), a viewer (no New project, no Invite) and a balance of 10,000 or more, two hard loads each.

2026-11-26 (orchestrator, signed-in dev browser, 1512 px wide). The hint script moved from the root layout's `next/script` (queued until the bundle boots: the properties appeared ~140 ms after the chrome was in the DOM) to an inline script in the app layout (`InlineScript`, per Next's pre-hydration guide); the properties are now set at the first DOM snapshot, before first contentful paint. Hard reload with a stored hint, positions of all five top-bar controls, the nav and the heading compared pending against ready: identical for an owner on Business (`/projects`) and for an owner on Free with the Upgrade button and a locked Invite (`/home`: search at 804.5 px, Invite 106.8 px, pill 222.7 px in both states). Not checked: a viewer, a balance of 10,000 or more, mobile widths. Not done (Sol, P3): re-measuring when the desktop bar becomes visible after crossing `lg`; a stale hint costs one shift.
