# Claude final production-readiness review (2026-10-30)

Verdict: GO — no P0/P1. Owner pre-launch checks (a)–(d) are already satisfied:
(a) both new migrations applied on Neon (verified in `_prisma_migrations`); (b) Railway
worker drainingSeconds = 40 (≥ 30 s drain); (c) owner confirmed the R2 7-day
incomplete-multipart rule; (d) Stripe endpoint subscribed to checkout.session.expired.

## P2
1. Migrations can race the API: only the worker runs `prisma migrate deploy`, but API and
   worker deploy together; `20261030120000` claims "current code never reads/writes the
   column" yet new API code reads `ClipRender.captionDiagnostics` → reads fail until the
   worker's migration lands. Fix: `/api/ready` fails while migrations are pending (or an API
   pre-deploy migration-status gate); correct the migration comment. (`docs/runbooks/environments.md:160-164`)
2. (Owner/console checks — done, see above.)
3. Audio-gap scan cost on every clip (`clip-render-attempt.ts:2791-2798`, `worker-process.ts:299-349`):
   re-reads the clip window incl. video bytes; deadline is the 120 s probe timeout; pretty JSON
   (~58 B/packet) overflows the 2 MiB stdout cap past ~13 min windows → silent skip; Vorbis's
   two block sizes can false-flag gaps. Fix: `-of csv=p=0`, own ~15 s deadline, log scan
   duration via render telemetry, skip variable-frame-size codecs.

## P3
4. `bun audit --production` exits 1 (11 advisories: 10 moderate, 1 low). hono@4.12.28 CORS
   ReDoS only reachable via unused `publicReadCors` (`apps/api/src/http/cors.ts:111`). Fix:
   hono ≥ 4.13.11, delete `publicReadCors`. Others via svix>uuid, archiver>brace-expansion,
   Prisma dev server.
5. Pending Business cleanup content check omits webhook subscriptions, callback signing
   secrets, completion callbacks, invites, workspace events, thumbnail ops, audio favorites,
   performance guidance (`pending-business-workspace.service.ts:10-18`); safe today only via
   capability gating. Fix: test that every Workspace relation is counted or allow-listed.
6. Invalid REST v1 keys not throttled pre-auth (`apps/api/src/domains/rest/routes.ts:178-186`);
   `/api/ready` runs an unauthenticated DB query per call. Fix: coarse per-IP limit via
   `trustedIngressIp`.
7. `resumeBusinessWorkspaceCheckout` returns `checkoutUrl` without schema validation
   (`packages/api-client/src/billing/mutations.ts:146-150`); lint has 12 non-blocking diagnostics.

## Verified solid
Gates: lint, typecheck 15/15, `bun run test` 4089 pass, inventory 283 routes, OpenAPI 31 ops,
web split + bundle scan, env:check; DB gates (local PG17) all green. Deployed probes: health
version b10e36eab0af, ready OK, CORS exact allowlist (foreign/null → 403), 401s on /api, /api/v1,
/mcp (with resource_metadata), discovery correct, unsigned webhooks 400. MCP exact-audience;
SSRF-safe pinned fetch with redirect revalidation; review passcode per-IP limits; no secrets in
logs; pending-workspace locking/billing-facts/open-session guard; render-group fencing; local
macOS workers can't claim shared renders (runtime lock is linux-x64 only); folder 409 backed by
the DB unique constraint.
