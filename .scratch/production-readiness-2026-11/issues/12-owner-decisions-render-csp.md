# 12 Owner decisions: source grant caching and CSP reports

**What to build:** Decisions 6 and 7 from `../decisions.md`.

**Blocked by:** None

**Status:** done

## 6. Cache source grants
`apps/media/python/narriflow_media/source_server.py:146-148` calls `source-read` for every 1 MiB upstream read. Each call re-reads the input capsule, takes domain locks and upserts an inbox receipt (`packages/services/src/render-group-execution.ts:45-65,118`, `execution-transfer.ts:297-321`). Grants live up to 120 s.

Build:
- Cache each source's grant until `expiresAt` minus a safety margin, and reuse it across chunks.
- Keep `assert_live()` per chunk, so a local cancel still stops reads at once.
- Refresh on expiry and on a 403. Keep etag, content-range and length verification exactly as they are.
- Update the "fresh grant per chunk" docstring and any matching doc to the new design.
- A Python unit test proves many chunks produce one `source-read`, plus refresh on expiry and on 403.

**Frozen:** this changes transport only. Do not change FFmpeg args, ranges requested, bytes returned, or `ScopedSourceServer`'s LRU. The bytes reaching FFmpeg must be identical.

## 7. CSP reports
`apps/web/next.config.ts:90-100` has a stricter Report-Only policy with no reporting destination, and enforces only `frame-ancestors 'none'` outside `/review`.

Build, without enforcing anything new:
- A public API route, `POST /api/csp-report`, declared in the correct domain's `admission.ts` as independent trust. Accept both `application/csp-report` and `application/reports+json`. Bounded body under 64 KiB through `readBoundedBody`, IP rate limited, always answers 204.
- Log a structured warning with only blocked host, directive and document path. Strip query strings. Never store the body, and never log a full URL. No database write.
- Add `report-uri` and `report-to` plus a `Reporting-Endpoints` header to the Report-Only policy, using the configured API origin.
- Add the production Clerk host to the Report-Only allowlist only if a configured value provides it.
- Do not add nonces and do not enforce the policy. Enforcing is a later step once reports exist.
- Update `apps/api` route inventory expectations if needed, and `docs/runbooks` with how to read the reports.

## Comments

### 2026-11-04 implementation

**6. Source grants.** `source_server.py`: `ScopedSourceServer._grant` keeps one verified `source-read` grant per source (per-source lock, so concurrent readers share one call) until its `expiresAt` minus 30 s. It refreshes on expiry and on a 403 (only the rejected grant is dropped). A grant without a parseable `expiresAt` is never reused. The `object` check still runs on every real `source-read`; `assert_live()` still runs per chunk; headers, ranges, etag/content-range/length checks, retries and the LRU are untouched. The docstring now describes reuse. New `GrantReuseTests` in `tests/test_source_server.py`: 4 MiB over many chunks gives 1 `source-read` and identical bytes; local cancel stops reads with a cached grant; refresh inside the margin; one refresh on 403 with the same range. `unittest tests.test_source_server`: 15 tests OK (11 existing unchanged).

**7. CSP reports.** `POST /api/csp-report` (`apps/api/src/domains/platform/csp-report.ts`, mounted in `app.ts`, declared in `platform/admission.ts` as new independent trust `public_browser_report`). Both content types, 64 KiB via `readBoundedBody`, per-address `publicRead` budget (a limiter failure also drops the report), always 204, OPTIONS preflight with `Access-Control-Allow-Origin: *`. It logs only `blockedHost`, `directive` and `documentPath` (no query, no body, no database). `next.config.ts`: `report-uri`, `report-to csp-endpoint` and a `Reporting-Endpoints` header on the Report-Only policy only; the production Clerk host (decoded from a `pk_live_` publishable key) joins script/connect/frame-src only when configured. No nonces, nothing newly enforced. Runbook: `docs/runbooks/csp-reports.md`. Tests: `csp-report.test.ts` (4) and two cases in `apps/web/next-config-csp.test.ts` (5 total).

**Verification.** `bun test` on csp-report, admission-tables, route-inventory (93 pass), next-config-csp (5 pass). `bun run typecheck` 15/15 tasks. `test:inventory` 297 routes, 0 problems. `check:web-split` passed. Biome clean on every file I touched; repo `bun run lint` still reports 1 error in `brand` audio presign code (ticket 11's area, not touched).
