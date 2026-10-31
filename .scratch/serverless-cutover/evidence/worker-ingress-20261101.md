# Worker ingress verification

The API runs on Workers. Bun 1.3.6 remains the fast-test runner and native media runtime; it no longer supplies the API HTTP server.

## Semantic map

| Former coverage | Current proof |
| --- | --- |
| Bun `maxRequestBodySize`, bare 400/413, empty body and connection reuse | Removed. These are Bun server behaviors and do not describe Workers ingress. The unused native-cap constant was removed. |
| Route-class 413 with typed envelope, request ID and first-party CORS | Full application composition tests, plus actual local workerd network requests. A real missing-CORS bug above the global ordinary ceiling was fixed with the existing first-party refusal policy. |
| Signed 20 MiB Scribe delivery with declared or streamed bytes | Actual local workerd HTTP transport through the full API composition and Worker scopes; exact 200/ignored, with real HMAC verification. |
| Raw-byte signature integrity | Actual workerd accepts the original whitespace/escape bytes and rejects reserialization, a changed large body, and an unsigned large body with exact 401/invalid_signature. |
| Clerk/Stripe/Zoom 1 MiB class | Actual workerd declared and streamed oversize requests get exact 413/envelope/request ID; exactly 1 MiB reaches Stripe signature verification and returns exact 400/missing_signature. |
| First-party, REST and MCP ordinary ceiling | Actual workerd declared 17 MiB requests get exact 413/envelope/request ID. Only the allowed first-party origin receives its CORS headers. |
| First-party class streaming counter | Actual workerd HTTP accepts the 2 MiB streamed fixture into the limiter and returns exact 413. A fixed internal 9 MiB stream proves early cancellation and CORS through the same full application. Direct composition also keeps the original 9 MiB streamed refusal. |
| Provider 128 MiB application bound | Fixed internal workerd Requests prove declared rejection and byte counting/cancellation at 128 MiB + 1. Repeated references to one 1 MiB buffer avoid a 128 MiB allocation. These fixtures prove the counter, not real edge transfer or isolate memory capacity. |
| REST schedule revision schema | Snapshot changed only the six reviewed lines adding the required scheduleRevision property. The committed public OpenAPI artifact did not change. |

Wrangler 4.156.0's local HTTP proxy/client resets a 9 MiB unknown-length upload when the application cancels it early. The workerd counter proof uses an internal Request for that case instead of accepting reset/400 as a valid application refusal. This gate does not claim public-edge early-cancel transport behavior or public HTTP keepalive behavior.

## Platform limit

Cloudflare's published incoming body limit follows the domain's Cloudflare plan, independently of Workers Paid. Free and Pro domains have a 100 MB maximum and the edge returns 413 before application code above its limit. On the stated Free domain plan, the published effective public ingress ceiling is therefore 100 MB. The application providerResult bound remains 128 MiB. This is a documentation-based limit, not a deployed edge measurement. Cloudflare documents 128 MB per isolate for both Workers plans. [Primary source, checked 2026-11-01; updated 2026-10-29](https://developers.cloudflare.com/workers/platform/limits/#request-and-response-limits).

## Local results

- Pinned Bun 1.3.6 focused API suites: 101 passed, 0 failed, 1,091 assertions, two snapshots.
- Pinned Bun 1.3.6 full API fast suite: 921 passed, 39 PostgreSQL tests skipped, 0 failed, 4,999 assertions, two snapshots.
- `bun run --cwd apps/api test:ingress:workerd`: 17 checks passed on workerd via Wrangler 4.156.0, compatibility date 2026-10-30. The database client factory is poisoned. No SQL, provider requests, account changes or deployments.
- API TypeScript, focused Biome and diff whitespace checks passed.

Logs are in `/tmp/narriflow-api-ingress-port-focused.log`, `/tmp/narriflow-api-ingress-port-full.log` and `/tmp/narriflow-api-ingress-workerd.log`.
