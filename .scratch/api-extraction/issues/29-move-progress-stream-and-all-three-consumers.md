# 29. Move progress stream and all three consumers

**What to build:** The existing stream runs beyond Next function duration and all three consumers share a Bearer fetch/parser connection with replay and narrow invalidation.

**Blocked by:** [03 - Build typed client transport and cache scope](03-build-typed-client-transport-and-cache-scope.md), [10 - Convert Project detail composition and panels](10-convert-project-detail-composition-and-panels.md), [16 - Convert upload intake and recipe UI](16-convert-upload-intake-and-recipe-ui.md), [30 - Move exports downloads and delivery pages](30-move-exports-downloads-and-delivery-pages.md)

**Status:** ready-for-agent

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

- [ ] Server preserves DB replay/Redis subscribe/catch-up/gap/fallback/bounds, 15s heartbeat with fresh token/membership/status/Project checks and cleanup.
- [ ] Wire protocol event names/data.seq and authorization control match current schema; one safe revoke then close; HTTP failures checked before parser.
- [ ] All three exact EventSource sites replaced by shared refcounted fetch/parser owner and 5s trailing/terminal-dedup invalidation.
- [ ] Scope change/expiry/revocation/Redis loss/reconnect and >60s run verified without reload storms or unbounded memory/connections.
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
