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

## Resolution (Claude) — item 7

`resumeBusinessWorkspaceCheckout` now parses the response with `resumeBusinessWorkspaceCheckoutResponseSchema` (new, `packages/validators/src/api/billing.ts`; `checkoutUrl` must be a URL whose origin is exactly `https://checkout.stripe.com`). Anything else throws a typed `ApiError` (`unexpected_response`, "We couldn't open checkout. Try again in a moment.") and the caller never navigates. Tests: `packages/api-client/src/billing/billing.test.ts` (foreign host, http, lookalike subdomain, `javascript:`, empty); existing resume fixtures moved to `checkout.stripe.com`. Not changed: `startBusinessWorkspaceCheckout` still validates only `z.url()`; tightening it would reuse the same schema but touches the server-side response schema and many `.test` fixtures.

## Resolution (Sol)

Implemented items 1, 3, 4, 5 and 6 from this review, plus F4 from `review-sol.md`.

- Readiness checks every SQL migration shipped in the API image against finished, non-rolled-back `_prisma_migrations` rows. No database writes. Responses cache successes and failures for five seconds, coalesce concurrent probes, and wait at most two seconds. A slow underlying query remains shared across cache windows. The first readiness probe starts a 180-second startup watchdog; failure to become ready logs the deadline and exits 1. Missing names and query failures have separate sanitized logs. Successful startup cancels the watchdog. Updated the migration comment and environment runbook, including worker-migration failure recovery.
- Audio packet scans emit CSV for the selected audio stream's `pts_time` only, use a maximum 15-second deadline and a bounded 16 MiB output buffer, skip Opus/Vorbis, and degrade subprocess failures to no scan. Render cancellation still aborts. The render telemetry records `probe/audio_gap_scan` duration. A synthetic 900-second, 400-packet/sec test fits the buffer; actual continuous-source argv and decoded PCM remain identical.
- Hono is pinned to 4.13.11, brace-expansion to 2.1.7, and transitive uuid to 11.1.1. All three Hono workspace manifests match. Removed unused `publicReadCors` and its test-only usage. Svix's only uuid call is v4; Node CommonJS resolution/generation succeeds with the override. Patched version references: [brace-expansion advisory](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr), [uuid advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq). `bun audit --production --audit-level=moderate` reports no vulnerabilities across 707 packages, so no remaining advisory exceptions.
- Pending Business removal now counts every list relation, including callbacks/signing secrets/subscriptions, invites, events/keys, thumbnail operations, favorites, OAuth state, review/manual-decision records and finishings. Performance guidance and event counters must be absent. A generated Prisma DMMF test compares every Workspace relation with the counted, selected or explicitly checked relations and documents reasons for the identity/membership/billing exceptions. Each content relation is tested as a removal blocker.
- REST authentication applies a coarse 600/minute source limit before parsing or looking up credentials, using `trustedIngressIp` with the configured trusted header and socket fallback. Unknown key rotation shares the same source bucket. Existing key-specific limits and post-auth admission stay intact. Readiness query caching supplies its separate unauthenticated query limit.
- Corrected `deploy-env.md` to name Railway service-managed settings and added `/patches/**` to its watch list. It now describes migration-aware readiness too.

Focused verification: readiness/audio tests 35 passed; REST/app/CORS tests 105 passed; workspace cleanup tests 7 passed. Local-only DB wrapper gates: workspace-billing 30 passed, integration-api 7 passed. Inventory 283 application + 44 protocol routes, OpenAPI 31 operations, web split including available bundle all passed. Native golden all-suite PASS: 18/18 normal identical, 16 corrected contracts pass, two expected failures unchanged; report `/tmp/narriflow-golden/candidate-final-sol/report.md`.

First full test attempt had one existing 5-second FFmpeg logo-fixture before-hook timeout while the golden suite was encoding concurrently. The full rerun without golden contention passed. Initial cross-owner lint/email-type failures were corrected by their owner. No commits, pushes, deployments, shared DB writes, env edits or termination of other agents' processes by Sol.

## Resolution (Claude, round 2)

- P2 "newer finished work" on a fresh review round: confirmed cause was the `fingerprint !== pinned fingerprint` branch of `newerWorkAvailable` against the clip's latest ready export. The fingerprint hashes revision + aspect ratios + resolution + watermark, so any other ready export of the same revision (a Download at another size or format set, made just before the round) differs and flagged the round immediately. The `clip.editorRevision > item.editorRevision` branch cannot fire at creation (the handoff requires the export revision to equal the clip's current revision).
- Fix: `hasNewerReviewedWork` in `packages/services/src/review.service.ts` (used by `internalProjection` and `internalRoom`) is true only when a reviewed clip's editor revision moved past the pinned one (real newer edits). Dropped the fingerprint branch and its exports/fingerprint selects.
- Test: `vizard-expansion.db.test.ts` "a review round is not stale because of another export of the same revision, only because of later edits" (a just-made 720p/watermark ready export exists; both projections false; bump clip revision -> both true). Gate `db-gate.sh bun run test:vizard-expansion:db`: 72 pass, 0 fail.
- Business checkout URL: `businessWorkspaceCheckoutResponseSchema.checkoutUrl` now uses `stripeCheckoutUrlSchema` (exactly `https://checkout.stripe.com`). `startBusinessWorkspaceCheckout` and resume share `unopenableCheckout()` -> `ApiError` `unexpected_response`, no URL returned. `billing.test.ts` fixture moved off `checkout.stripe.test`; new test rejects evil host, http, lookalike subdomain, javascript:. API route tests mock the service and never parse this schema, so unchanged.
- Checks: biome clean on touched files; validators 622 / api-client billing 15 / services review 49 (6 DB skips) / api billing 24 tests pass; tsc clean for validators, api-client, services.


Final gates: `bun run lint` passed, with the existing 11 warnings and one informational diagnostic; all 18 Sol-owned lint paths are clean. `bun run typecheck` passed 15/15 tasks. `bun run test` passed 12/12 Turbo tasks with zero failures, including 1,126 worker tests. `bun run --cwd apps/api test:inventory`, `bun run --cwd apps/api openapi:check`, `bun run check:web-split`, both touched DB gates through `.scratch/api-extraction/db-gate.sh`, the exact requested render-golden verification command, and `git diff --check` all passed. Logs are `/tmp/nf-sol-{lint-complete,typecheck-complete,test-final,inventory-final,openapi-final,web-split-final,billing-db,integration-db,golden}.log`.
