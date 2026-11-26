# 02 - Chrome renders pending

**What to build:** The prerendered HTML of every app route is the real chrome plus that route's skeleton, and the chrome fills in place when the Workspace is ready. Nothing is replaced or moved.

**Blocked by:** [01 - Gate at the scope hook](01-gate-at-the-scope-hook.md)

**Status:** done

Spec: [../spec.md](../spec.md). Files: `apps/web/app/(app)/_components/{app-chrome,sidebar,mobile-nav,workspace-switcher,credits-menu,account-menu,global-search,settings-chrome,project-workspace,use-settings-return,workspace-status-notice}.tsx`, `packages/ui/src/components/page-loading.tsx`.

## Behaviour

1. **All four chrome variants render while pending**: default shell, settings chrome, project workspace, upload funnel. The variant is picked by pathname as today. Static parts are real from the first byte: logo, nav links (they navigate immediately), the collapse button, theme toggle, Back links, the settings section list, the panel and header frame, the mobile bar and its drawer with the nav links.
2. **Data slots show a placeholder of the final size** (same wrapper element, same box): workspace switcher (32px image, two text lines, its padding), "New project" (full width × 36 plus its margin), credits meter (label row and track), search field (240 × 32), Invite, credits menu trigger, account avatar (32², 28² in the drawer), the drawer's name/email rows, the settings Workspace heading (one line). Measure the real controls; do not guess. Placeholders use `Bone`, are `aria-hidden`, are not focusable and open nothing.
3. **Conditional slots.** While pending, show the placeholder for the common case (an editor on an active Workspace: "New project" and Invite present). When ready, a slot the person does not get collapses once. Upgrade gems, the Workspace status notice and the selection-changed banner have no placeholder and appear when ready.
4. **`UpgradeProvider`** wraps the chrome and the page in every state; while pending it holds its existing defaults. Check every `useUpgrade`/`LockedButton`/`UpgradeGem`/`UpgradeHero` use that can render before a screen has data and make sure none shows a wrong plan state while pending.
5. **No `useSearchParams` outside a Suspense boundary in anything a static route prerenders.** `useSettingsReturn` moves into the settings branch behind a boundary whose fallback uses `/home` as the Back target. `ProjectWorkspace` and `ProjectSkeleton` read the `view` param; isolate those reads so the frame and the skeleton do not depend on the URL to render. The static app routes (`/home`, `/projects`, `/settings/*`, …) must stay statically prerenderable: no request-time API in the layout or chrome.
6. **No storage, time or randomness during render** in the chrome's pending path. The sidebar's collapsed state stays in memory.
7. **Busy state.** Only the content region is `aria-busy` (the route skeleton's `LoadingScreen` already is); the chrome is not. Bones in the chrome are decorative.
8. **Reveal immediately.** Content replaces its skeleton with no delay or stagger. `settings/billing/billing-screen.tsx` staggers its reveal today; remove the stagger.
9. **Skeleton fidelity.** For `/home`, `/projects` and `/settings/billing`, compare the route skeleton with what the screen renders for an editor on an active Workspace and fix mismatches in height or position that would make content jump.

## Acceptance

- [ ] With Clerk blocked or delayed, a hard load of `/home`, `/projects`, `/settings/billing`, `/upload` and `/projects/<id>` paints its chrome variant and route skeleton from the server HTML, before any script runs.
- [ ] When the Workspace becomes ready no chrome element changes position or size for an owner on an active Workspace.
- [x] Nav links work while pending; no placeholder takes focus.
- [ ] The Studio route keeps its own full-screen skeleton and is unaffected by the chrome.
- [x] Existing chrome tests and fixtures pass (`app-shell`, `workspace-switcher`, `credits-menu`, `upgrade`, `workspace-status-notice`), updated where they pinned the old gate.
- [x] `bun run lint`, `bun run typecheck`, `bun run --cwd apps/web test`, `bun run check:web-split` pass, or unrelated failures are named with evidence.

## Comments

2026-11-26 (implementer). `AppChrome` takes one `ShellData | null`; all four variants render while it is null. Placeholders: `WorkspaceSwitcherPlaceholder`, `CreditsMenuPlaceholder`, `AccountAvatarPlaceholder`, `GlobalSearchPlaceholder`, the sidebar meter and "New project" bones, the mobile drawer's meter and account rows, `InvitePlaceholder`, and the settings Workspace heading. Text lines use the new `LineBone` (`packages/ui/src/components/page-loading.tsx`): a non-breaking space at the text's own font size sets the line box, so the height is exact by construction. Content-sized controls (Invite, the credits pill, the Projects header actions) are hidden stand-ins of the real control inside a `Bone` (Chakra Skeleton hides its children), so their size is the control's own. Fixed boxes: avatar 32² (28² in the drawer), search 240 × 32, switcher tile 32², button height 36. Pending shows "New project", Invite and "Developer access" (the owner's case); upgrade gems, the status notice and the selection-changed banner appear only when ready.

URL reads: `useSettingsReturn` became `SettingsReturnTracker`, which renders null inside its own Suspense boundary on every route once the Workspace is ready (it still has to see pages outside settings to know where Back goes); Back is `/home` until it reports. `ProjectWorkspace` no longer reads `?view=`: the project page root and `ProjectSkeleton` carry `data-project-view`, and the stylesheet selects on that (`.main:has([data-project-view="gallery"])` for the wide gallery). `ProjectSkeleton` reads the URL inside its own boundary, with a gallery/Clips fallback.

Reveal: removed the billing stagger and the /projects card fade-up stagger (up to 660 ms). Skeleton fidelity: Home's Autopilot skeleton gets the card's 1px edge; the Projects skeleton gets the editor's "New folder" / "New project" actions, which stack under the title on phones. Billing is unchanged: its status-card action button and date line depend on plan state, and I could not decide a common case without data.

Verified: app-shell fixture renders the real layout + `Provider` with `renderToString` while Clerk is not loaded and `useSearchParams` suspends (as a static prerender bails out), for `/home`, `/projects`, `/settings/billing`, `/upload` and `/projects/<id>`. Each case asserts the chrome marker, exactly one `aria-busy` (the route skeleton's), no requests, and a hydration with no console errors and no recoverable errors other than the project skeleton's intended URL boundary. Mutation check: an unwrapped `useSearchParams()` in `AppChrome` fails all five. Another case checks that while pending the nav links are real and no `aria-hidden` subtree contains a link, button, input or tabindex.

Not ticked:
- Hard-load paint with Clerk blocked: shown only by the render test, not by a real browser or `next build` (banned). Needs the orchestrator's browser check.
- "No chrome element changes position or size": not measured, since happy-dom has no layout. Sizes come from the theme, plus stand-ins and line boxes that are exact by construction. The credits pill's stand-in holds a three-digit balance, so a larger or smaller balance changes its width by a digit or so, and the right-aligned header items beside it shift by that much.
- Studio unaffected: reasoned (the `/clips/` branch of `ProjectWorkspace` is unchanged and returns the page as is), not tested.

Left `claimed`: the unticked boxes need a browser check on the running dev servers; close the ticket after that check passes.

2026-11-26 (implementer, review fixes):

- Upgrade prompt: `UpgradeProvider` takes the admitted `workspaceId`. A prompt is stored with the Workspace it was opened in and cleared once that changes or is lost, so returning to the first Workspace does not reopen it either. Upgrade fixture case: "an open prompt closes and is forgotten when the admitted Workspace changes or is lost".
- Settings Back: `AppChrome` stores the tracker's `{ workspaceId, destination }` and renders `/home` unless it belongs to the admitted Workspace. While pending, it records the last page outside settings in memory, and the tracker applies it on mount: against no saved state if the saved one belongs to another Workspace, which `settingsReturnState` would otherwise turn into `/home`. App-shell case: "settings Back takes a page left while the Workspace opened, and never another Workspace's". Mutations: removing the Workspace match fails it, and so does removing the pending record.
- Credits pill: the balance sits in `BalanceBox`, a grid cell shared by a hidden "0,000" and the balance in tabular figures. The placeholder uses the same box, so any balance up to four digits with a separator fills in without moving the search field or Invite. Five-digit balances still widen the pill. Accepted one-time growth with no reserved space: the gold Upgrade button inside the pill (an owner below Business, when a higher plan has room) and the gem on a locked Invite appear only once the plan is known.
- Slot drift: the switcher placeholder reserves the chevron's 14px (after the 10px gap). The settings Workspace heading bone sits inside the text's 12px inset, and the real heading truncates to one line. The mobile drawer's account rows use the same `Stack` wrapper (`flex="1"`) pending and ready, and a missing email keeps its line with a non-breaking space. The sidebar and drawer meter amounts use a 14ch tabular bone, about "0,000 of 0,000 left". It is right-aligned, so its width moves nothing.
- `/projects`: both pending branches (no scope yet, and the explorer's first read) are the same `LoadingScreen` region as `loading.tsx`, with the Workspace recovery notice kept in the second. The real-page render case asserts exactly one `aria-busy`; reverting the pending branch fails it.

Not measured: the pixel results of the above need the browser check (happy-dom has no layout).

2026-11-26 (orchestrator, signed-in dev browser, hard loads). `/home`, `/projects`, `/settings/billing`, `/upload`, `/projects/<id>` and the Studio paint their chrome variant and route skeleton in the first frame and fill in place; no console or hydration errors. After the A8/A9 fixes the top bar's five controls, the nav links, the switcher box and the hero heading have identical rects pending and ready for an owner on an active Business Workspace (`/home`, 1494 px viewport). Not measured: owners below Business (the Upgrade button and locked-Invite gem grow the top bar once, accepted), mobile widths. Prerender safety is proven by the render test only; no `next build` was run.
