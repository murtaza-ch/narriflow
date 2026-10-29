# 28. Convert review share and internal review UI

**What to build:** Review/share/internal review UI uses separated guest or first-party queries, expiring media grants and explicit opt-out confirmation.

**Blocked by:** [27 - Move review guest share and opt-out API](27-move-review-guest-share-and-opt-out-api.md), [07 - Move billing API and convert billing UI](07-move-billing-api-and-convert-billing-ui.md)

**Status:** claimed

**Suggested implementer:** Sol. The other pairing side reviews and returns findings to this owner.

Read [spec.md](../spec.md). It is the complete contract; the original brief/plan/reviews are not prerequisites. Claim this ticket before editing.

## Exact ownership

Paths are repo-relative. Every existing file below is exclusively assigned for this phase, including files that only need verification. A new `/**` directory includes its local tests/helpers, not adjacent directories. Read other files as evidence; do not edit them.

Existing files:

- `apps/web/app/(app)/projects/[projectId]/project-share-button.tsx`
- `apps/web/app/(app)/projects/[projectId]/project-share-model.test.ts`
- `apps/web/app/(app)/projects/[projectId]/project-share-model.ts`
- `apps/web/app/(app)/projects/[projectId]/review-panel.tsx`
- `apps/web/app/review/[token]/page.tsx`
- `apps/web/app/review/[token]/review-client-model.browser.test.ts`
- `apps/web/app/review/[token]/review-client-model.ts`
- `apps/web/app/review/[token]/review-client.browser.fixture.tsx`
- `apps/web/app/review/[token]/review-client.browser.test.ts`
- `apps/web/app/review/[token]/review-client.tsx`
- `apps/web/app/share/[token]/not-found.tsx`
- `apps/web/app/share/[token]/page.tsx`
- `apps/web/app/share/[token]/shared-export-client.tsx`
- `apps/web/lib/review-preselection.test.ts`
- `apps/web/lib/review-preselection.ts`

New files/directories or reserved skeletons handed off by a blocker:

- `apps/web/app/review/opt-out/page.tsx`

Consume the endpoint contracts owned by 27. API changes belong to those owners; this ticket owns caller conversion and cache effects.

## Endpoints, actions, pages and refresh sites

Rows retain their section/ordinal or exact source-line identifier from the independent inventory. Abbreviated table filenames are accompanied by the literal ownership manifest and exact source occurrences below. All action/page/fetch/refresh rows in owned files are in scope, including no-refresh callers and media navigation. Baseline observations do not override the spec's selected origins, route style, guest Bearer or new endpoints.

### Inventory 2.B page/type row at inventory line 259

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/share/[token]/page.tsx` (20) | none (public token; inventory `public_share_token`) | `clipExportService.getShared(token)` L14 | params `token`; `dynamic="force-dynamic"`, `revalidate=0` | `notFound()` when missing or no downloadable variant (L15/L17) | `SharedExportClient{exported}` | **NEW public `GET /api/share/:token`** (independent-trust; no session; CORS open for `GET`). |

### Inventory 2.B page/type row at inventory line 260

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/review/[token]/page.tsx` (16) | none | none (already client-driven: `ReviewClient{token}` calls `/api/review/:token/**`) | params `token` | none | `ReviewClient{token}` | none; the review routes already exist as `app/api/review/[token]/[[...review]]/route.ts` (section 4) |

### Inventory 5.2 refresh/fetch row at inventory line 723

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `(app)/projects/[projectId]/review-panel.tsx:294` | Any review-round action | `POST /api/projects/:id/review-rounds{path}` (:282); then local `refresh()` (:269, `GET .../review-rounds`) | Review tab (local state) plus project page |

### Inventory 5.2 refresh/fetch row at inventory line 724

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `(app)/projects/[projectId]/project-share-button.tsx:106` | Share create/revoke | `POST /api/projects/:id/review-rounds{path}` (:94); then `loadRoom()` (`GET`, :76) | Share state (local) plus project page |

### Inventory 5.9 refresh/fetch row at inventory line 846

| file:line | Trigger | Call | Refreshes |
| --- | --- | --- | --- |
| `app/review/[token]/review-client.tsx:156,180,200` (public, token auth, no Clerk) | Load; grant access (`POST .../access`); comments `POST|PATCH|DELETE comments[/:id]` (:223,:241,:624,:646); `POST decision` (:251) | `/api/review/:token/**` (served by `app/api/review/[token]/[[...review]]/route.ts`) | Local state; no router |

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/[projectId]/project-share-button.tsx

```text
76: const response = await fetch(endpoint, { cache: "no-store" });
94: const response = await fetch(`${endpoint}${path}`, {
106: router.refresh();
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/[projectId]/review-panel.tsx

```text
270: const response = await fetch(endpoint, { cache: "no-store" });
282: const response = await fetch(`${endpoint}${path}`, {
294: router.refresh();
```

### Inventory 5 exact file occurrences: apps/web/app/review/[token]/review-client.tsx

```text
156: const response = await fetch(endpoint, { cache: "no-store" });
180: const response = await fetch(`${endpoint}/access`, {
200: const response = await fetch(`${endpoint}/${path}`, {
```

Also account for the inventory's cross-domain traps: query-only actions, action forms that relied on revalidatePath, signed downloads/media, OAuth anchors, all three EventSource consumers and unload keepalive. Only the literal files above may be changed by this ticket.

## Acceptance criteria

- [x] Public review/share, opt-out and internal review/share components call correct independent or first-party client without backend types/values.
- [x] Guest sessionStorage is tab-scoped by hashed review token, cleared on expiry/refusal; no raw credential in query keys/logs/persisted cache.
- [x] Media uses short-lived storage grants, comments/decision refetch narrowly and internal preselection uses shared pure decoder.
- [x] Opt-out human page explicitly confirms POST; no GET/unmount/automatic effect unsubscribes; existing noindex/CSP/no-referrer/no-store retained.
- [x] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun test apps/web/app/review apps/web/app/share
bun run --cwd apps/web typecheck
```

Verify the changed flow in the running Next app against the separate API origin. Follow the repo's runtime/browser verification guidance; record steps, result and origin pair. Do not treat compilation as browser evidence.

## Comments

Append claim, requested seam changes, paired review and evidence here.

- Claimed by GPT-6.1-Sol, 2026-10-29. Request for ticket 31: in `apps/web/next.config.ts`, add the exact configured API origin to review `connect-src`, retaining noindex, no-referrer, no-store and restrictive CSP headers. This is required by the reviews client handoff for cross-origin review, share and opt-out requests.

- Sol review-fix handoff, 2026-10-29, findings M1/L11: review playback/download grants now last up to 15 minutes, capped by session and round expiry. Share `expiresAt` is the earliest actual R2 URL expiry minus 30 seconds, replacing the fixed 60 seconds. API-client media/share options use expiry-based freshness and disable focus refetch. Keep `<video src>` stable for the selected item/variant/mode throughout playback and pauses; focus/refetch must not swap it. On an explicit new playback attempt or expired-URL recovery, acquire the current grant and restore currentTime if src must change. Follow response expiry rather than fixed 60-second polling. Add browser coverage for >60-second playback, pause/focus, and background refresh preserving src/currentTime. No ticket 28 source edited by this fixes pass.


- Continued by GPT-6.1-Sol, 2026-10-29. On entry `dev` already contained the client conversion and no owned source had partial edits. Audited all owned files: internal reads/commands use the scoped reviews subpath, guest/share/opt-out reads use the independent client and hashed keys, guest Bearer storage expires/refuses correctly, mutations retain intent keys and invalidate only affected reads, opt-out confirms only through an explicit POST, and preselection uses the shared validator decoder. No backend import, raw fetch, router refresh, server action or HTML interpolation remains in this scope.
- Addressed paired handoff M1/L11: selected item/variant/mode now owns a stable mounted video URL. Expiry-based background renewal updates cache/download links without changing playing or paused src/currentTime; focus only refreshes when due. Expired play/error recovery acquires the current grant and restores the playhead and playback state. Share downloads refresh expired grants before storage navigation; empty shares retain the existing unavailable view. Layout, styles, controls and metadata are unchanged.
- Changed source: `review/[token]/review-client-model.ts`, `review/[token]/review-client.tsx`, `share/[token]/shared-export-client.tsx`; regression coverage in the two owned review model/browser fixture files. Other owned files needed verification only. Existing `apps/web/next-env.d.ts` and concurrent agents' edits were left alone. No commits, dependency installs, env-file edits or DB suites were performed.
- Tests: `bun test apps/web/app/review apps/web/app/share 'apps/web/app/(app)/projects/[projectId]/project-share-model.test.ts' apps/web/lib/review-preselection.test.ts` passed, 12 top-level tests with the subprocess browser fixture's 15 scenarios. Covers >60-second playback, playing/paused focus and background refresh, expired-play/error recovery preserving currentTime, item identity, guest refusal/expiry, uncertain command replay/narrow invalidation, explicit opt-out, empty shares and escaped untrusted text. A direct fixture/model/preselection run before the final two scenarios also passed, 18 tests.
- Lint: `bunx biome check --write <all 16 owned TS/TSX paths>` passed with no changes or warnings; final `git diff --check` passed. `bun run env:check` passed.
- Typecheck: ran `bunx tsc -p apps/web/tsconfig.json --noEmit` exactly once, exit 2. It reported three owned grant-inference errors at review-client.tsx:264/572 and shared-export-client.tsx:31; fixed all three by supplying explicit `ReviewMediaGrant`/`SharedExport` fetchQuery result types. Did not repeat the command, per the implementer instruction. The 13 unrelated diagnostics are in `apps/web/lib/authenticated-request-action.ts` and `authenticated-request-page.ts`, missing moved policy modules and dependent implicit/unknown types, owned by ticket 31. The final integrated typecheck remains a 31/32 gate; this is not a claim of a green whole-web typecheck.
- Runtime: started only Next with a process-local public API origin override, W=`http://localhost:3000`, A=`http://localhost:4000`; no env file was edited and no API/worker was started. Next 16.3.6 Turbopack MCP `get_compilation_issues` returned `issues: []`; `get_errors` returned no config/session errors. The real browser rendered the original Name/Email/Passcode access form and Open review control. Preview snapshots timed out twice, so switched to agent-browser 0.33.1, observed the DOM, submitted synthetic access input and captured `securitypolicyviolation`: enforced `connect-src` blocks A's `/api/review/.../access`; the existing inline network error appeared. Live successful guest/media/share/opt-out and signed-in flows therefore remain for 32 after the configuration seam below. Both browser sessions and only the Next process started here were closed.
- Ticket 31 request, confirmed in the live browser: add `new URL(NEXT_PUBLIC_API_URL).origin` to review `connect-src` and the applicable report-only policy in `apps/web/next.config.ts`, preserving existing restrictive directives/noindex/no-referrer/no-store. The review page emitted no-referrer and noindex/nofollow/noarchive; config retains private/no-store, while Next dev overrides Cache-Control to no-cache/must-revalidate, so verify production headers in 32. No unsafe HTML/script interpolation was found; the hostile-text regression passes. No spec deviation or design objection; CSP/configuration and the final cross-origin pass remain with their named owners.

- Sol claimed the paired-review fixes on 2026-10-29. Scope includes M1-M3 and L1-L3; the user also authorized the matching integrations API change.
