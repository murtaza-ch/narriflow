# 01 - Gate at the scope hook

**What to build:** Inside the app shell the page always renders, and the rule "no screen runs a scoped request before a validated Workspace is in force" is enforced by `useWorkspaceScope()` returning `null`, not by unmounting the tree.

**Blocked by:** None.

**Status:** done

Spec: [../spec.md](../spec.md). Files: `apps/web/app/_components/{api-provider,workspace-query-gate}.tsx`, `apps/web/app/(app)/layout.tsx`, `apps/web/app/(app)/_components/app-chrome.tsx`, their tests and browser fixtures.

## Behaviour

1. **Identity readiness is a condition of the hooks.** `ApiProvider` keeps `ready = isLoaded && runtime userId === Clerk userId`. It gains a way to render children while not ready (the app shell uses it; every other consumer keeps the blocking fallback). While not ready, `useApiScope()`, `useIdentityScope()` and `useWorkspaceScope()` report no identity and no Workspace, whatever the runtime scope holds. A child effect can run before the provider's `setIdentity` effect while `getToken` already answers for the new user, so this must hold on every render, not only the first.
2. **The app shell's gate is a provider that always renders children.** It exposes a derived value: `pending`, `failed` (with what `GateFailure` needs), or `ready` with `{ session, bootstrap, scope, selectionChanged, dismissSelectionChanged, revalidate }`.
   `ready` = adopted ∧ fresh (the existing refusal/`dataUpdatedAt` rule) ∧ the selected Workspace is among the memberships ∧ `content.view` ∧ the Workspace bootstrap read for that same scope has data. Never pair one Workspace's bootstrap with another's scope: between `selectWorkspace(B)` and B's bootstrap arriving the value is `pending`.
3. **`useWorkspaceScope()` returns the gated scope.** Inside the app shell it is non-null only in `ready`. The raw runtime scope (which holds the unvalidated localStorage hint before adoption, and follows another tab's hint with no validation) gets a distinct name and is used only by the gate itself and by code that must act before validation; list each such use in the ticket comments. Check every caller of `useWorkspaceScope`, `useIdentityScope`, `useApiScope` and `runtime.scope.snapshot()` under `apps/web` (including `workspace-switcher.tsx`, `ShellAccountMenu`, `studio-cloud-http.ts`, the continuation shell and the standalone pages) and keep each one's behaviour correct.
4. **Adoption state resets when the identity changes**, including sign-out followed by sign-in as another user and a failed sign-out that restores the user (`app-chrome.tsx` `beginSignOut`). Today this holds only because the gate unmounts. The first resolution from "no identity" to the signed-in user must not remount the page.
5. **Workspace switch remounts the page, not the chrome.** The page subtree is keyed so it remounts when the adopted Workspace changes from one non-null id to a different one, and not at the first adoption. Components holding captured intents rely on this so a refused command never replays in another Workspace.
6. **Membership and view checks stay part of readiness**, with their effects kept: a selection missing from the memberships revalidates; a Workspace the person cannot view goes to `/workspace-unavailable`; a restricted bootstrap sends the owner to billing and everyone else out. The query-cache listener that leaves on `workspace_restricted` subscribes for the gated scope only.
7. **Failure renders inside the content panel.** `GateFailure` gets a panel-sized variant; the chrome stays. The standalone pages keep the full-page one.
8. **Standalone pages keep a blocking gate.** `workspace-unavailable-view.tsx`, `clerk-oauth-continuation.tsx` and `continuation-shell.tsx` read `useSessionGate().session` and need it non-null. Share the adoption state machine between the blocking gate and the provider; do not fork it.
9. **Remove** `ShellPending` and the empty-box fallback in `(app)/layout.tsx`.

## Acceptance

- [x] Server render of the app shell equals the first client render (no hydration warning) with Clerk not loaded.
- [x] No scoped request from a screen starts before adoption; the existing seven gate cases still pass, reworded from "DOM absent" to "gated scope is null and status is pending" where they asserted absence.
- [x] Switching users resets adoption; restoring the user after an aborted sign-out re-adopts.
- [x] Another tab changing the hint while pending or ready never exposes an unvalidated scope.
- [x] After a refusal, no data of the refused Workspace is exposed while revalidating.
- [x] The page subtree mounts once across first adoption and remounts on a Workspace switch.
- [x] `bun run lint`, `bun run typecheck`, `bun run --cwd apps/web test`, `bun run --cwd packages/api-client test`, `bun run check:web-split` pass, or unrelated failures from other agents' uncommitted work are named with evidence.

## Comments

2026-11-26 (implementer). Design:

- `ApiProvider` keeps `ready = isLoaded ∧ runtime user = Clerk user` and gains `renderWhilePending`. Readiness is also re-derived inside the hooks on every render (`useRuntimeScope()` compares the runtime snapshot with Clerk's user from context), so a child effect that runs before `setIdentity` sees no identity. `useApiScope` is renamed `useRuntimeScope` (the raw, unvalidated scope) and carries `identityVersion`: the scope version of the last user transition, tracked by a listener registered when the runtime is created, so A → null → A is never missed.
- `useWorkspaceScope()` reads only the admitted scope from `AdmittedWorkspaceScope`, which `WorkspaceGateProvider` renders with the ready scope. Outside a gate it is null.
- One adoption hook (`useSessionAdoption`) serves the blocking `SessionGate` (standalone pages) and `WorkspaceGateProvider` (app shell). Its state is keyed by `identityVersion`, so sign-out, account switch and an undone sign-out start adoption over without remounting anything.
- `WorkspaceGateProvider` derives `pending | failed | ready` in one place: adopted ∧ fresh ∧ membership ∧ `content.view` ∧ the bootstrap read for that same scope has data whose `workspace.id` equals the scope. Membership revalidation, the unavailable redirect, the restricted redirect and the cache listener (now only for the admitted user + Workspace) are kept. The idle bootstrap read uses `skipToken`, because `transport.scoped()` rejects an empty Workspace.
- The page key lives in `AppShell` (`usePageKey`): it bumps only when the admitted Workspace moves from one non-null id to another. Failure renders `GateFailure variant="panel"` in place of the page.
- Removed: `WorkspaceQueryGate`, `WorkspaceBootstrapView`, `ShellPending`, the layout's empty-box fallback.

Raw runtime scope, remaining uses: the two gate hooks (the hint for the session bootstrap; the candidate to validate); `useIdentityScope` (user only); the provider's `storage` listener (matches the event key to the user); `studio-cloud-http.ts` keepalive (an unload-time check that the captured gated scope is still the runtime's, which cannot wait for React); `workspace-switcher.tsx` (user id only, for the checkout return hint; renders only when ready); `workspaces/new/create-workspace-form.tsx` (standalone page outside the shell; the current Workspace is recorded only as a checkout return hint).

Verified: gate fixture has 13 cases (the 7 old ones reworded, plus Clerk loading late, user switch, aborted sign-out, another tab's hint while pending and ready, refusal while revalidating, and the blocking gate). Mutation checks: removing the per-render identity check fails the user-switch case; removing the per-identity reset fails the user-switch and sign-out cases. App-shell fixture: mount once across first adoption, remount on switch, and server render vs hydration with Clerk not loaded for five routes. `bun run --cwd apps/web test` 1463 pass, api-client 234 pass, typecheck pass, check:web-split pass. `bun run lint` fails with 169 errors, all in other agents' untracked files (`.scratch/caption-templates-v2/**`, `narriflow-emoji-prototype.html`); Biome on the 34 files this work touched reports none.

2026-11-26 (implementer, review fixes). Every case below was written first and seen failing for the reason given, then fixed:

- Refusal freshness: `refusal` is now the session bootstrap query's `dataUpdateCount`, read from the query cache at the moment of refusal, and only a strictly later success is fresh. Before, it was the rendered `dataUpdatedAt`, which missed a success already in the cache but not yet rendered, so a failed re-read re-adopted the refused Workspace. It could also stall when two successes landed in the same millisecond. Case: "a failed refresh after a refusal never re-adopts the refused Workspace, even when a background read landed first". The failure rule became "an error before adoption is a failure" (`!data || !adopted`), which covers the refused case too.
- A moved selection: the gate records the hint each successful bootstrap read was sent with, matched to the `dataUpdateCount` that success produced. Before adopting, it compares that hint with the current selection. If another tab moved it, the gate reads again with the current hint and does not adopt; a failed re-read shows the retry. Cases: "a pending bootstrap never undoes another tab's valid selection" and "refusal recovery never undoes another tab's valid selection".
- Failed sign-out: `beginSignOut(runtime)` in `api-provider.tsx` (used by the account menu and the mobile drawer) restores the user only while the scope version is still the one its sign-out produced. Case: "a sign-out that fails after the account switched does not put the previous user back", plus "a sign-out that fails restores the same user".
- A Workspace bootstrap refused as paused redirected twice: the cache listener now skips the bootstrap's own key, so its error belongs to the bootstrap effect alone. Case: "a Workspace bootstrap refused as paused leaves once".
- Fixture gaps: the revalidation case now asserts from the moment the refusal reached the probe (`refusedAt`), not from the first pending effect. A screen-like probe (`/api/screen`) starts by itself when the gated scope becomes non-null, and `expectNoUnvalidatedScope` checks that every such request carried the Workspace admitted at that moment. The app-shell switch case asserts that the `aside` node survives while the page node is replaced. The server-render cases render the real `/home` and `/projects` pages (Home's request notice reads the URL inside the page's own boundary: one client-rendered boundary).

Raw runtime scope, one more use: the hard-load route prefetch (ticket 03), next to the gate in `usePrefetchUnderSavedHint`.
