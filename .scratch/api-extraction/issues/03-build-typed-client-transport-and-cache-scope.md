# 03. Build typed client transport and cache scope

**What to build:** First-party requests use injected Bearer transport, typed ApiError and identity/Workspace-scoped React Query state without Clerk/Next in api-client.

**Blocked by:** [02 - Build HTTP admission and staff guard](02-build-http-admission-and-staff-guard.md)

**Status:** done

**Suggested implementer:** Claude. The other pairing side reviews and returns findings to this owner.

Read [spec.md](../spec.md). It is the complete contract; the original brief/plan/reviews are not prerequisites. Claim this ticket before editing.

## Exact ownership

Paths are repo-relative. Every existing file below is exclusively assigned for this phase, including files that only need verification. A new `/**` directory includes its local tests/helpers, not adjacent directories. Read other files as evidence; do not edit them.

Existing files:

- `bun.lock`

New files/directories or reserved skeletons handed off by a blocker:

- `packages/api-client/package.json`
- `packages/api-client/tsconfig.json`
- `packages/api-client/tsconfig.build.json`
- `packages/api-client/src/core/**`
- `packages/api-client/src/index.ts`
- `apps/web/app/_components/api-provider.tsx`

## Endpoints, actions, pages and refresh sites

Rows retain their section/ordinal or exact source-line identifier from the independent inventory. Abbreviated table filenames are accompanied by the literal ownership manifest and exact source occurrences below. All action/page/fetch/refresh rows in owned files are in scope, including no-refresh callers and media navigation. Baseline observations do not override the spec's selected origins, route style, guest Bearer or new endpoints.

No direct UI/domain rows. This ticket supplies the shared contracts or final gates described above.

## Acceptance criteria

- [x] Transport captures identity+Workspace, omits cookies, obtains a current token, propagates AbortSignal and rejects stale-scope responses.
- [x] ApiError.code maps error field; safe status/details/requestId retained; at most one forced token refresh with the same intent key/body.
- [x] QueryClient defaults, retry decisions, canonical filter keys and scope switch/sign-out cancellation match spec; tokens/grants are not persisted.
- [x] Reusable mutation form/recovery interfaces and stable provider contracts are documented for UI owners; api-client imports no Clerk/Next/runtime API value.
- [ ] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun test packages/api-client/src/core
```

## Comments

Claimed and implemented by Claude (Sonnet 5.5), 2026-10-29. Paired review not run by the implementer (last acceptance box left open for the orchestrator).

### Public contract for later tickets (`@narriflow/api-client`, import from the package root)
- Wiring: `createApiRuntime({baseUrl, getToken, hintStorage?, fetch?, onAuthenticationFailed?, onWorkspaceSelectionChanged?})` returns `{scope, transport, queryClient, hints, setIdentity(userId|null), selectWorkspace(id|null), syncHintFromStorage(), createIntent()}`. Web wraps it in `apps/web/app/_components/api-provider.tsx` (`ApiProvider`, `useApiRuntime`, `useApiScope`, `useIdentityScope`, `useWorkspaceScope`). The provider renders children only after Clerk loaded and the runtime identity matches, so mount it around authenticated app/continuation/review UI only (ticket 06 mounts it; it is not in the root layout). It needs `NEXT_PUBLIC_API_URL`.
- Requests: every call is bound to an explicit scope, never to ambient state. `runtime.transport.scoped({userId, workspaceId})` (sends `X-Workspace-Id` from that value) or `.identity({userId})` (no Workspace header) return `{fetch, json, open, baseUrl}`. `fetch(url, init)` is shaped for Hono `hc(baseUrl, {fetch})` or per call `$post(args, {fetch})`; `json(path, {method, query, json, headers, signal, idempotencyKey, parse})` is for non-hc use; `open(path, init)` is for streams. A bound scope that is no longer current is refused locally with `scope_changed` before any network call; non-2xx throws `ApiError`; foreign origins are refused; `credentials: 'omit'` and `Authorization` cannot be overridden. A response whose `X-Workspace-Id` differs from the requested Workspace is discarded (`workspace_response_mismatch`).
- Query factories take the captured `WorkspaceScope` (from `useWorkspaceScope()`) and use `scopedKey(scope, domain, resource, idOrFilters)` / `sessionKey({userId}, 'bootstrap')` / `guestKey(sha256Hex(token), ...)` / `shareKey(...)`. Filters go through `canonicalize` (sorted keys; Date/bigint/Set/Map/function/NaN/undefined-in-array and credential-named properties throw). Pass `signal` from the query function to `json({signal})`/`fetch(.., {signal})`. Invalidate with `invalidateScoped(queryClient, scope, domain, resource?, idOrFilters?)` / `invalidateSession`. `STALE_TIME.{default 30s, config 60s, live 0}`, `POLL_INTERVAL_MS {2000..5000}`.
- Errors/recovery: `ApiError {code, status, requestId, details, issues, retryAfterSeconds}`; branch with `describeApiFailure(error).kind` (`authenticate|reselect_workspace|workspace_mismatch|workspace_restricted|forbidden|upgrade|missing|conflict|rate_limited|retry_later|validation|offline|superseded|failed`); `workspace_restricted` is deliberately left to the gate (owner -> billing, member -> workspace-unavailable). `fieldErrors(error)` gives `{ 'a.b': message }` for inline form errors. Client-only codes are in `CLIENT_ERROR_CODES` (`network_error`, `scope_changed`, `workspace_selection_required`, `workspace_response_mismatch`, `unexpected_response`, `stream_idle`). Treat `superseded` as "ignore, the user moved on", never as an error toast.
- Mutations: no automatic retries. Mint one key per intent: `const intent = runtime.createIntent<Input>(); mutationFn: (input) => api.create(input, intent.keyFor(input)); onSuccess: () => intent.complete()`. The key survives timeouts, lost responses and the 401 token refresh (the transport replays the same body and headers once); a changed input, user or Workspace mints a new one. Do not call `complete()` on uncertain failures. Inputs must be plain JSON (no Date/File). Credential-issuing commands (API key, signing secret) must not use automatic retry and must surface `credential_already_issued`.
- Streams: `runEventStream({transport: scoped(...), path, signal, query: (cursor) => ({sinceSeq: cursor ?? undefined}), decode, cursorOf, onEvent, onStatus})` resolves `{reason: 'aborted'}` or `{reason: 'fatal', error}`. HTTP errors are read before parsing (401 after the transport's single forced refresh, 403, 404, 409 are fatal; transport/5xx/429/idle/decode failures reconnect with a fresh token, jittered backoff and `Retry-After`, resuming from the last *applied* cursor). A scope change aborts the connection and ends the run as fatal `scope_changed`. Heartbeat comments keep the idle watchdog (45 s default) quiet. `readStreamMessages(response)` is the bare `eventsource-parser` layer. One-subscription-per-project refcounting and event schemas/dedupe belong to ticket 29.
- Scope transitions (`ApiScope`): sign-out/user change aborts every tracked request and `queryClient.clear()`s (queries and mutations); a Workspace switch aborts only that Workspace's requests, removes its queries and clears pending mutations, keeping `session` and guest/share queries. Order: abort in flight -> cancel/clear -> move scope -> notify. Sequence for bootstrap: `runtime.setIdentity(userId)` (restores the saved hint), fetch identity bootstrap, then `runtime.selectWorkspace(effectiveWorkspaceId)` BEFORE priming scoped keys. Only the Workspace id hint is persisted (`narriflow:workspace:<clerkUserId>`, localStorage); another tab's change arrives via the `storage` event and the provider follows it through the same cancelling transition. A removed hint surfaces as 409 `workspace_selection_changed` -> `onWorkspaceSelectionChanged`; never replay the command.
- `queryClient` defaults: stale 30 s, gc 5 min, refetch on focus/reconnect, reads retry at most twice for network/5xx/429 (never other 4xx; `Retry-After` honoured up to 30 s, longer ends retrying), `retry: false` for mutations, and `dehydrate` returns nothing so grants and personal data cannot be persisted or SSR-serialized.

### Deviations / decisions
- Core uses `@tanstack/query-core` (re-exported class identity with `@tanstack/react-query`), keeping it React-free; `@tanstack/react-query` is declared for the hooks later tickets add.
- The default `onAuthenticationFailed` in the provider replaces the route with the existing sign-in entry carrying `pathname+search`; ticket 06 may override per surface.
- `packages/api-client/package.json` build script is `tsc -p tsconfig.build.json --noEmit` (source-exported package, same as `apps/api`): a declaration build emitted `.d.ts/.js` into `packages/validators/src/api/` through the temporary `paths` mapping, which I removed. After ticket 04 adds `./api/*` exports to `packages/validators/package.json`, delete the `paths` block in `packages/api-client/tsconfig.json`.
- The `X-Workspace-Id` admitted-header check, `scope_changed`, `workspace_selection_required`, `stream_idle` and the `describeApiFailure` taxonomy are additions the spec implies but does not name.

### Requests for other owners
- 31 (or the orchestrator sooner, because ticket 06+ cannot import the client without it): `apps/web/package.json` add `@narriflow/api-client: workspace:*`, `@tanstack/react-query` and `@tanstack/react-query-devtools` (same `^5.105.0`), then `bun install` (installs are isolated per package, so web cannot resolve them otherwise); `apps/web/tsconfig.json` add paths `@narriflow/api-client` -> `../../packages/api-client/src/index.ts`; `apps/web/next.config.ts` add `@narriflow/api-client` to `transpilePackages`. `api-provider.tsx` is type-correct against these (checked with a temporary path-mapped tsconfig, removed) but cannot compile in the real web project until they land.
- 04: `packages/api-client/package.json` and `src/index.ts` are yours next; `src/index.ts` currently only has `export * from "./core"`, and `package.json` lists `@narriflow/validators`, `@tanstack/query-core`, `@tanstack/react-query`, `eventsource-parser` and peer `react`. Add validators `./api/*` subpath exports (also requested by 02) so the tsconfig `paths` can go.
- 06: mount `ApiProvider` and wire identity bootstrap -> `runtime.selectWorkspace`; remove `validateCoreEnv`/billing validation from the root layout as the spec says (not touched here).

### Evidence
- `bun test packages/api-client/src/core` -> 110 pass, 0 fail (9 files: error 10, keys 11, scope 12, transport 27, query-client 15, idempotency 5, stream 19, runtime 9 incl. cross-Workspace in-flight/replay/mutation cases, boundaries 2). Boundaries test bundles the core for the browser and proves no next/react/clerk/hono/prisma/backend-workspace module is in the graph.
- `bunx biome check packages/api-client apps/web/app/_components/api-provider.tsx` clean. `packages/api-client` `bun run typecheck` and `bun run build` clean. `bun install --frozen-lockfile` consistent; lock diff is the new workspace entry, `@tanstack/query-core|react-query` 5.105.0 and `eventsource-parser` 4.1.3 hoisted for api-client (nested 3.0.6 kept for `eventsource` and `@modelcontextprotocol/client`).
- Web provider type check: temporary path-mapped tsconfig, clean (file removed). No unit test for the provider itself (needs the web wiring above).
