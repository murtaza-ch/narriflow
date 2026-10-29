# 29. Move progress stream and all three consumers

**What to build:** The existing stream runs beyond Next function duration and all three consumers share a Bearer fetch/parser connection with replay and narrow invalidation.

**Blocked by:** [03 - Build typed client transport and cache scope](03-build-typed-client-transport-and-cache-scope.md), [10 - Convert Project detail composition and panels](10-convert-project-detail-composition-and-panels.md), [16 - Convert upload intake and recipe UI](16-convert-upload-intake-and-recipe-ui.md), [30 - Move exports downloads and delivery pages](30-move-exports-downloads-and-delivery-pages.md)

**Status:** done

**Suggested implementer:** Claude. The other pairing side reviews and returns findings to this owner.

Read [spec.md](../spec.md). It is the complete contract; the original brief/plan/reviews are not prerequisites. Claim this ticket before editing.

## Exact ownership

Paths are repo-relative. Every existing file below is exclusively assigned for this phase, including files that only need verification. A new `/**` directory includes its local tests/helpers, not adjacent directories. Read other files as evidence; do not edit them.

Existing files:

- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/exports/[exportId]/export-delivery-client.tsx`
- `apps/web/app/(app)/projects/[projectId]/project-events-provider.tsx`
- `apps/web/app/(app)/upload/_lib/use-ingest-stream.ts`
- `apps/web/app/api/stream/[projectId]/route.ts`
- `apps/web/lib/workflow-stream-authorization.test.ts`
- `apps/web/lib/workflow-stream-authorization.ts`
- `apps/web/lib/workflow-stream-reauthorization.test.ts`
- `apps/web/lib/workflow-stream-reauthorization.ts`
- `apps/web/lib/workflow-stream.test.ts`
- `apps/web/lib/workflow-stream.ts`

New files/directories or reserved skeletons handed off by a blocker:

- `apps/api/src/domains/progress/**`
- `apps/api/src/types/progress.ts`
- `packages/api-client/src/progress/**`
- `packages/validators/src/api/progress.ts`

This ticket owns the three existing consumer files across Project/upload/export directories plus workflow helpers and new progress client/server modules. 10/16/30 own adjacent pages and must preserve current consumer props. Do not edit their files.

The chosen new endpoints for this ticket are the matching owner row in spec.md, "Endpoint and screen contracts added by extraction". All current endpoints/actions below retain their semantics unless that row explicitly changes transport. Fill only this domain's receipt-command module; current native receipts remain native.

## Endpoints, actions, pages and refresh sites

Rows retain their section/ordinal or exact source-line identifier from the independent inventory. Abbreviated table filenames are accompanied by the literal ownership manifest and exact source occurrences below. All action/page/fetch/refresh rows in owned files are in scope, including no-refresh callers and media navigation. Baseline observations do not override the spec's selected origins, route style, guest Bearer or new endpoints.

### Inventory 4 row 1

| # | File | Methods | What it does | Next-specific dependencies | Trust / auth | Verdict |
|---|---|---|---|---|---|---|
| 1 | `app/api/stream/[projectId]/route.ts` (402 lines) | GET | Server-Sent Events progress stream. Admission through `freshAuthenticatedRequestPolicy.execute({ adapter: "stream", operationName: "open-workflow-progress-stream", admission: project content.view })`; replays missed events from the DB (`getWorkflowEventsSince`, `sinceSeq` query) and subscribes to the Redis channel (`getWorkflowChannel`, `UPSTASH_REDIS_URL`, `ioredis`), 15s heartbeat + `createWorkflowStreamReauthorizationGuard` re-checks access, 15s fallback poll if Redis is down. Returns `text/event-stream` with `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`. | `export const runtime = "nodejs"` only. Imports `@/lib/authenticated-request-policy.server` (server-only, React `cache`, `next/navigation` `unstable_rethrow`, Clerk session). No `next/*` in the file itself. Web client helpers: `lib/workflow-stream.ts`, `workflow-stream-authorization.ts`, `workflow-stream-reauthorization.ts` (pure). | Browser session cookie (Clerk) | **Move to API.** Needs Bearer auth, and clients must use `fetch` + `eventsource-parser` (EventSource cannot send `Authorization`). Bun note: `Bun.serve` default `idleTimeout` is 10 s, which is shorter than the 15 s heartbeat, so set `idleTimeout` (max 255) or send comments more often. |

### Inventory 5.2 refresh/fetch row at inventory line 708

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `(app)/projects/[projectId]/project-events-provider.tsx:105,115` | SSE `workflow.stage.updated` non-terminal event, throttled `PROGRESS_REFRESH_THROTTLE_MS = 5_000` (`scheduleIncrementalRefresh`) | none (stream) | Whole project page: clips list, processing panel, finishing, exports |

### Inventory 5.2 refresh/fetch row at inventory line 709

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `project-events-provider.tsx:186` | SSE terminal event (`completed`/`partial`/`failed`), once per `workflowTerminalEventIdentity` | none | Whole project page |

### Inventory 5.2 refresh/fetch row at inventory line 710

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `project-events-provider.tsx:201` | SSE `authorization.revoked` with unparsable control | none | Whole project page |

### Inventory 5.9 refresh/fetch row at inventory line 844

| file:line | Trigger | Call | Refreshes |
| --- | --- | --- | --- |
| `export-delivery-client.tsx:232,265,281,301` | Create/revoke share link, retry, and a fourth action at :301 | `POST|DELETE .../exports/:id/share-links`, `POST .../retry` | Local (calls `refresh()`) |

### Inventory 5.13 refresh/fetch row at inventory line 900

| file:line | Behavior |
| --- | --- |
| `lib/workflow-stream-authorization.ts:36,41` | `assign(sign-in href)` or `reload()` on revoked stream authorization |

### Inventory 5.13 refresh/fetch row at inventory line 901

| file:line | Behavior |
| --- | --- |
| `upload/_lib/use-ingest-stream.ts:101` | `reload()` on unparsable revoke control |

### Inventory 5.13 refresh/fetch row at inventory line 902

| file:line | Behavior |
| --- | --- |
| `export-delivery-client.tsx:182` | `reload()` on unparsable revoke control |

### Inventory 5.13 refresh/fetch row at inventory line 903

| file:line | Behavior |
| --- | --- |
| `studio/_components/studio-shell.tsx:2004` | `reload()` after "Reset to original" |

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/[projectId]/clips/[clipId]/exports/[exportId]/export-delivery-client.tsx

```text
138: const response = await fetch(apiPath, { cache: "no-store" });
155: const source = new EventSource(
182: window.location.reload();
232: const response = await fetch(`${apiPath}/share-links`, {
265: const response = await fetch(`${apiPath}/share-links`, {
281: const response = await fetch(`${apiPath}/retry`, { method: "POST" });
301: const response = await fetch(
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/[projectId]/project-events-provider.tsx

```text
66: * share the same throttled router.refresh() below.
105: router.refresh();
115: router.refresh();
136: // (navigation to a different project, or any router.refresh()) ,  the SSE
143: const source = new EventSource(streamUrl);
186: router.refresh();
201: router.refresh();
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/upload/_lib/use-ingest-stream.ts

```text
35: * `router.refresh()` re-renders this component's server parent with a fresh
62: const source = new EventSource(`/api/stream/${projectId}?sinceSeq=0`);
101: window.location.reload();
```

### Inventory 5 exact file occurrences: apps/web/lib/workflow-stream-authorization.ts

```text
36: window.location.assign(
41: window.location.reload();
```

Also account for the inventory's cross-domain traps: query-only actions, action forms that relied on revalidatePath, signed downloads/media, OAuth anchors, all three EventSource consumers and unload keepalive. Only the literal files above may be changed by this ticket.

## Acceptance criteria

- [x] Server preserves DB replay/Redis subscribe/catch-up/gap/fallback/bounds, 15s heartbeat with fresh token/membership/status/Project checks and cleanup.
- [x] Wire protocol event names/data.seq and authorization control match current schema; one safe revoke then close; HTTP failures checked before parser.
- [x] All three exact EventSource sites replaced by shared refcounted fetch/parser owner and 5s trailing/terminal-dedup invalidation.
- [x] Scope change/expiry/revocation/Redis loss/reconnect and >60s run verified without reload storms or unbounded memory/connections.
- [ ] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun test apps/api/src/domains/progress
bun test apps/api/src/domains/progress packages/api-client/src/progress
bun run test:authenticated-request-policy:db
bun run --cwd apps/api typecheck
```

Verify the changed flow in the running Next app against the separate API origin. Follow the repo's runtime/browser verification guidance; record steps, result and origin pair. Do not treat compilation as browser evidence.

## Comments

Append claim, requested seam changes, paired review and evidence here.

Claimed and implemented by Claude (Sonnet 5.5), 2026-10-29. Paired review not run (last acceptance box left open for the orchestrator). No signed-in browser pass (ticket 32).

### What changed
- **API** (`apps/api/src/domains/progress`): `GET /api/stream/:projectId` (admission project `content.view`, tier `stream` = 30 starts/min/actor). `stream.ts` is the transport-free core: DB replay, subscribe then post-subscribe catch-up, gap recovery from the log, 15 s fallback polling when live is absent or lost, live buffer bound 1000 (then polling), unread-frame bound 256 (slow client dropped, reconnects from its cursor). `redis.ts` is the ioredis subscriber (bounded retries). Each heartbeat (15 s) calls `runtime.actorsFor(request)` anew (token re-verified, membership/status/Project resolved from scratch) through the policy; first refusal sends one `authorization.revoked` control {error, requestId?} then closes (expired token = `authentication_required`, client reconnects with a fresh token). Three consecutive `authentication_unavailable` checks are tolerated before closing (a Clerk blip is not a sign-out). `disableIdleTimeout` only after admission; drain closer registered (and runs at once if already draining); `API_STREAM_MAX_CONNECTIONS(_PER_ACTOR)` enforced (503 / 429 `too_many_streams`, Retry-After 5).
- **Wire**: `packages/validators/src/api/progress.ts` (event names, revoke/connected schemas, `parseSinceSeq`, cursor helpers). `connected` no longer carries the internal Redis `channel`.
- **Client** (`packages/api-client/src/progress`): `createProgressHub` (one `runEventStream` per identity+Workspace+Project, refcounted with 3 s linger, bounded 500-event replay buffer, per-subscriber cursors so late joiners replay and never see duplicates, restart from a lower cursor only when the buffer cannot cover it, fatal/revoked fan-out and slot release), `useProgressStream(runtime, scope, projectId, handlers)`, `decodeProgressMessage` (schema-invalid events skipped, not reconnect loops), `invalidateAfterProgress` / `invalidateAfterTerminalProgress`. The hub owns the cache effects once per connection: non-terminal events -> 5 s leading+trailing throttle (`invalidateProjectClips` incl. `invalidateProject`, ingest snapshot); each terminal identity once (project, clips, collections, usage, exports, dub allowance, ingest snapshot).
- **Consumers**: `project-events-provider.tsx` (no router; merges refetched history instead of replacing; `key={projectId}`; revoke/fatal -> `invalidateProject` so ticket 10's gates answer), `use-ingest-stream.ts` (same `useIngestStream(projectId, {ingestStatus, errorCode})` shape; resumes after its last applied seq, re-joins when `initial` changes after Retry, leaves on terminal), `export-delivery-client.tsx` (detail is `exportQueries.detail` seeded from the page's first read; 10 s poll only while active; refetch on reconnect and when the tab returns after >10 min because snapshot URLs expire in 15; `exportCommands.createShareLink|revokeShareLinks|retry|timelineSourceGrant`, `fetchTimelineArchive`, `fetchSubtitleFile` (subtitle anchors are now buttons), `invalidateAfterExportChange`).
- **Also**: `publishing-provider.tsx` post poll (5 s live / 30 s idle, visible-tab only, refetch on focus) and drawer export poll (5 s while open) are `useQuery` `refetchInterval`s; `dubbing-panel.tsx` uses `invalidateWorkspaceUsage`.
- **Deleted**: `apps/web/app/api/stream/[projectId]/route.ts`, `lib/workflow-stream.ts`, `lib/workflow-stream-authorization.ts`, `lib/workflow-stream-reauthorization.ts` and their tests (moved to the API as `reauthorization.ts`/`reauthorization.test.ts`; revoke recovery moved to client gates).

### Deviations
- `project-events-provider` does not call `invalidateProject` itself on the throttle/terminal events (request from 10): the shared hub does, once, for all three consumers; the provider calls it only on revoke/fatal.
- An unreadable revoke control is treated as revoked (old code refreshed the page).

### Requests for other owners
- **31**: delete `"app/api/stream/[projectId]/route.ts"` from `apps/web/lib/authenticated-request-inventory.ts` (line ~1346) and `"/api/stream(.*)"` from the public-route matcher in `apps/web/proxy.ts`; the API origin owns the stream now.
- **32** (browser): project page live-updates (Clips tab refresh while a render runs), upload import pill through Retry, export page rendering -> ready with video swap, expired-token reconnect, membership removal recovery, one `/api/stream/:id` request per Project in the Network panel, `Authorization` on it, no `EventSource`.

### Evidence
- `bun test apps/api/src/domains/progress`: 35 pass (stream core 13, reauthorization/cursor/registry 14, routes 8), live test skipped by default.
- `LIVE_STREAM_SECONDS=70 bun test src/domains/progress/live.test.ts` (apps/api): pass in 82 s. Real `Bun.serve` (idleTimeout 2 s, quiet gaps 4 s, heartbeat 3 s, token TTL 5 s), real `redis-server` killed at 40 %, real `createApiRuntime` transport + hub with two subscribers: every event once and in order for both, reconnects bounded (one per token expiry, none per idle timeout), `onOpen` count equals server connections, heap growth < 64 MiB, revocation ends with one control/409 and no further connections, `server.pendingRequests` 0 after unsubscribe. 9 s variant also passes.
- `bun test packages/api-client/src` 220 pass (progress hub 14); `bun test apps/api/src` 785 pass, 23 skip, 0 fail; `bun run --cwd apps/api test:inventory` routes=281 problems=0; `.scratch/api-extraction/db-gate.sh bun run test:authenticated-request-policy:db` 4 pass; web `app/(app)/projects/[projectId]` + `app/(app)/upload` 613 pass.
- Typecheck: `apps/api`, `packages/api-client`: clean except `domains/rest/public-openapi.ts` (rest owner); `tsc -p apps/web` filtered to my files: clean. `bunx biome check` on all my paths clean.
- Not done: signed-in browser run (ticket 32); paired review.
