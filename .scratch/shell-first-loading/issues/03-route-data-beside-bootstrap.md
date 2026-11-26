# 03 - Route data starts beside the bootstrap

**What to build:** On a hard load the current route's primary read starts as soon as the identity and a saved Workspace hint are known, in parallel with `/api/session/bootstrap`; nav links start their destination's read on intent.

**Blocked by:** [02 - Chrome renders pending](02-chrome-renders-pending.md)

**Status:** done

Spec: [../spec.md](../spec.md).

## Behaviour

1. **One registry**: route pattern → that route's primary reads, built from the same `queryOptions` factories the screens use, so keys match by construction. Start with the routes people land on: `/home`, `/projects`, `/projects/[projectId]`, and the other sidebar destinations whose screen has one clear primary read. A route without an entry behaves as today.
2. **Hard load.** Once the identity is ready and the runtime scope holds a saved hint, prefetch the current route's entries under that scope, once per identity. No hint → nothing. Screens still mount their queries only when the gated scope is non-null and then find the data in cache.
3. **Rules** (from the gate review):
   - prefetches run with `retry: false`;
   - a prefetched query that ended in error is removed, so the screen starts clean;
   - the Workspace bootstrap is never a registry entry.
4. **Intent.** Sidebar and mobile nav links prefetch the destination's entries on focus or sustained hover (not on scrolling touches), under the gated scope only. Reuse `usePrefetchExplorer` where it already does this.
5. No data read under an unvalidated hint is ever shown: it sits in a cache keyed by user and Workspace that only a screen with the validated, identical scope can read, and a Workspace move drops it.

## Acceptance

- [x] On a hard load of `/home` with a valid hint, `/api/home` starts before `/api/session/bootstrap` answers and is requested once.
- [x] Stale hint, 409 arrives before the bootstrap answers: no revalidation loop, the effective Workspace is adopted, the screen reads under it.
- [x] Stale hint, adoption moves the scope while the prefetch is in flight: the request is aborted as `scope_changed`, nothing is notified, no error is left in cache.
- [x] A prefetch refused as paused does not redirect before adoption.
- [x] First visit (no hint) issues no scoped request before adoption.
- [x] Gate fixture tests that asserted "before any scoped request" are reworded to "no data from the unvalidated hint is ever shown".
- [ ] `bun run lint`, `bun run typecheck`, `bun run --cwd apps/web test`, `bun run --cwd packages/api-client test` pass.

## Comments

2026-11-26 (implementer). Design:

- Registry: `apps/web/app/(app)/_components/route-reads.ts`, `routeReads(runtime, scope, href)`. Each entry calls the screen's own factory with the screen's own arguments: `/home` → `projectQueries.home`; `/projects` → `explorerQueryOptions` with `explorerFiltersFromSearch(search)` (the parser moved from `projects-screen.tsx` into `projects/_lib/api.ts`, so the screen and the registry share it); `/projects/[projectId]` → `projectQueries.detail(id, projectTabFromSearchParam(tab))`; `/performance` → `whatWorked` + `guidance`; `/autopilot` → `automationOverviewQueryOptions`; `/integrations` → `integrationsOverviewQuery`; `/brand-kit` → `brandQueries(...).kit()`. The module imports only query factories and the small filter parser, never a screen module, so the shell chunk does not grow by a screen.
- Not listed: `/search` (the read runs only for a submitted query), `/calendar` (its window is computed from the current date and the URL; a boundary would split keys), `/exports` (two reads with filters parsed by a helper that lives inside the screen module; importing it would pull the screen into the shell chunk; it can be added after moving `readFilters` out), `/recipes` (three reads, one conditional), `/upload` and settings pages (no single primary read). Projects-list links inside screens already use `usePrefetchExplorer`, which shares `explorerQueryOptions`.
- Hard load: `usePrefetchUnderSavedHint` in `workspace-query-gate.tsx`, run by `WorkspaceGateProvider` from its `prefetchUnderHint` prop. `AppShell` passes `(scope) => routeReads(runtime, scope, location.pathname + location.search)`, read when it runs. It runs once per `identityVersion`, marks the identity done even with no hint (so a later `storage` hint triggers nothing), skips the Workspace bootstrap key, prefetches with `retry: false`, and after a failure removes the query when nothing observes it. When a screen already joined the in-flight read (the bootstrap answered first) and the failure is one the screen would retry (`shouldRetryQuery`), it resets the query so the screen reads it again with its own retries; a non-retryable failure (409, 403, 404) is left as the screen's own answer. That observed-failure branch is untested.
- Intent: `useNavIntent()` returns focus/pointer handlers for each sidebar and mobile-drawer link (`NavLink` gained an `intent` prop). Focus prefetches at once, a resting mouse or pen pointer after 120 ms (cancelled on leave), touch never. It uses the gated scope only and plain `prefetchQuery`, so data still fresh under its `staleTime` is not read again.
- The raw runtime scope list from ticket 01 gains one entry: this hard-load prefetch, the only scoped request made under it.

Tests: gate fixture "route data beside the bootstrap" (valid hint read once and started while the bootstrap is held; stale hint 409 before the bootstrap with one bootstrap request and `/api/home` under `[REMOVED, PERSONAL]`; stale hint aborted as `scope_changed` with no error events and no cached REMOVED key; paused member's prefetch with no redirect until the gate's own `/workspace-unavailable`; first visit with no scoped request before adoption). The gate fixture's `Gates` now passes a prefetch, as the shell does, so the old cases run with it. Two were reworded: the removed-hint case and the Clerk-late case. App-shell fixture: a hard load of the real `/home` page with the real registry and a held session bootstrap requests `/api/home` before the bootstrap answers and once in total. Mutation: pointing the registry's `/home` entry elsewhere fails that case.

Not ticked: `bun run lint` fails with 168 errors, all in other agents' untracked `.scratch/caption-templates-v2/**`. Biome on every file this ticket touched is clean. Typecheck, web tests (1463 pass) and api-client tests (234 pass) pass. Untested in a browser: intent prefetch on hover and focus, and the hard-load overlap on the real API.

2026-11-26 (orchestrator). Browser, hard reload of `/home` with a saved hint: `/api/home` and `/api/session/bootstrap` start together and `/api/home` is requested once; content at 8.7 s against 13.9 s before (local API ≈ 5 s per call). The first run requested `/api/home` twice: in development StrictMode detaches a mounting screen's observer once, and React Query cancels a read whose signal was used when its last observer leaves. `detachedQueryFn` keeps the prefetch's signal to itself (the transport still aborts on a scope change). Focusing the Projects nav link starts `/api/projects/explorer` at once and the click reuses it. From the final Sol review: a route whose URL cannot be parsed no longer breaks the shell (the registry call is guarded), adoption checks the live selection before adopting, and settings' pending visit is taken only before the first admission. Lint box: repo-wide `bun run lint` fails only in other agents' untracked files; Biome on this effort's folders is clean.
