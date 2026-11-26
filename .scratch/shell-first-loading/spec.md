# Shell-first loading

**Status:** implemented 2026-11-26, uncommitted; prerender build gate pending the owner

## Problem

Hard-loading any app route shows four screens in a row: a blank frame, a generic skeleton with no sidebar or top bar, the chrome with the route skeleton, then the content. Measured on a local hard load of `/home` (signed-in test browser): first paint 0.6–0.9 s (blank), Clerk ready 1.1–1.5 s, `/api/session/bootstrap` 1.2 → 5.9 s, chrome appears 6.3 s, `/api/home` 6.2 → 13.7 s, content 13.9 s. The two API calls take 9.6 s back to back and 5.6 s side by side.

Cause: three serial waits, each with its own placeholder.

1. `ApiProvider` renders its fallback (an empty box) until Clerk has loaded, so the prerendered HTML of every app route is empty.
2. `AppShell` wraps the chrome and the page in `SessionGate` + `WorkspaceQueryGate`, whose fallback is the generic skeleton without chrome.
3. The page mounts only after both gates and only then starts its own query.

## Outcome

One layout from the first byte to the content. The prerendered HTML of an app route is the real chrome plus that route's own skeleton. Data fills fixed-size slots; nothing is replaced or moved.

## Decisions

Reviewed by Opus (gate correctness), Sol (Next 16.4 fit) and Astra (UX and risk) on 2026-11-26.

- **The shell never waits.** The chrome renders on the server and during hydration from a deterministic pending state. Slots that need identity or Workspace data show fixed-size placeholders.
- **The gate moves from the tree to the scope hook.** The page always renders. `useWorkspaceScope()` returns `null` until a validated Workspace is in force and its bootstrap is present. Every screen already returns its route skeleton for a null scope (audited: all 33 pages).
- **Readiness is derived, never stored.** `ready` = Clerk loaded ∧ runtime identity equals Clerk's ∧ adopted ∧ fresh ∧ the selected Workspace is a membership the person can view ∧ the Workspace bootstrap for that same scope is present. The chrome reads Workspace data only through it.
- **Standalone pages keep the blocking gate** (`workspace-unavailable`, `auth/continue`, the continuation shell).
- **Route data starts beside the bootstrap** (ticket 03). Sol and Astra advised against it because it issues scoped requests under an unvalidated hint; Opus traced the state machine and found it safe: a 409 before adoption is ignored because adoption is pending, a request in flight when adoption moves the scope is aborted as `scope_changed` and never notified, keys carry user and Workspace, and a Workspace move drops the old keys. The API validates membership on every request either way. It ships as its own ticket with the three rules Opus set and tests that pin both 409 cases.
- **Rejected:** taking a provisional identity and token from Clerk's `__session` cookie (a second identity source on the admission path; Clerk's own cookie selection handles suffixes, client UAT and handshake state); persisting a chrome snapshot in localStorage (stale flashes, shared computers; only the Workspace hint is persisted, by design); fetching API data from server components (reverses the browser-calls-the-API decision).
- **Deferred to their own change:** `cacheComponents` + `partialPrefetching` (app-wide migration touching docs, OG, llms and markdown handlers and segment flags; needs a preview build; does not make browser API reads start earlier), view transitions (pinned React 19.2.8 has no `ViewTransition` export), `<Activity>` state preservation (requires Cache Components; the Studio needs hide/resume checks first).

## Tickets

1. [01 - Gate at the scope hook](issues/01-gate-at-the-scope-hook.md)
2. [02 - Chrome renders pending](issues/02-chrome-renders-pending.md)
3. [03 - Route data starts beside the bootstrap](issues/03-route-data-beside-bootstrap.md)
4. [04 - Detail pages read params on the client](issues/04-client-params.md)
5. [05 - Remembered chrome slot sizes](issues/05-remembered-chrome-slot-sizes.md)
6. [06 - Reserved scrollbar gutter on framed pages](issues/06-scrollbar-gutter.md)
7. [07 - A request never goes out with another user's token](issues/07-token-owner-check.md)

## Verification

`bun run lint`, `bun run typecheck`, `bun run test`, `bun run check:web-split`. No `next build`, no DB gates (AGENTS.md). Browser check on the running dev servers (:3000, :4000) by the orchestrator. Prerender safety cannot be proven without a build; the owner decides how to run that gate.
