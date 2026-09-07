# Plan 002: Security response headers + SSRF guard on user-supplied URLs

> **Executor instructions**: Follow step by step; run every verification and
> confirm before proceeding. STOP conditions override improvisation.
>
> **Drift check (run first)**: `git diff --stat 05d273d..HEAD -- apps/web packages/services apps/worker` —
> large uncommitted tree; excerpts below are from the working tree on disk.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `05d273d`, 2026-07-06

## Why this matters

Two cheap, high-value hardening gaps for a product about to take paying users:
(1) There are **no security response headers** — no CSP, `X-Frame-Options`,
`X-Content-Type-Options`, or HSTS — so the app is embeddable in an iframe
(clickjacking) and browsers may MIME-sniff responses. (2) **SSRF**: RSS and
YouTube ingestion fetch **any** user-supplied URL with no scheme or private-IP
validation (`packages/services/src/rss.ts` `fetchRssEpisodes`, and the YouTube
URL handed to `yt-dlp` in `apps/worker/src/tasks/ingest.ts`), so a user can
point the server at `http://169.254.169.254/` or internal hosts. Both are
standard, well-scoped fixes.

## Current state

- `apps/web/next.config.ts` has **no** `headers()` block and there is no
  `apps/web/middleware.ts` (confirm: `ls apps/web/middleware.ts` → not found;
  `grep -n "headers()" apps/web/next.config.ts` → empty). Note: Clerk is the
  auth layer — if a `middleware.ts` already exists for Clerk, **extend it**, do
  not replace it. Check `grep -rn "clerkMiddleware\|authMiddleware" apps/web`.
- `packages/services/src/rss.ts:48-54`:
  ```ts
  export async function fetchRssEpisodes(rssUrl: string): Promise<RssEpisodeInput[]> {
    const response = await fetch(rssUrl, { headers: { ... } });
  ```
  No validation of `rssUrl` scheme/host.
- `apps/worker/src/tasks/ingest.ts` — the YouTube path spawns `yt-dlp` with the
  user URL (search for `yt-dlp` / `youtubeUrl`). `spawn()` with an argv array
  means no shell injection, but the URL host is unvalidated (SSRF surface).
- The URL-validation logic should live in one shared helper so both the web
  (RSS submission validation) and worker use it. Put it in
  `packages/services/src/url-guard.ts`.

Conventions: services are plain TS modules re-exported from
`packages/services/src/index.ts`. Errors thrown from services surface as failed
ingest jobs with an error code.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Tests | `bun run test` | all pass |
| Confirm no middleware yet | `ls apps/web/middleware.ts` | absent (or Clerk's — extend it) |

## Scope

**In scope**:
- Create `packages/services/src/url-guard.ts` + export from `packages/services/src/index.ts`.
- Create `packages/services/src/url-guard.test.ts`.
- Modify `packages/services/src/rss.ts` to validate before fetch.
- Modify `apps/worker/src/tasks/ingest.ts` to validate the YouTube URL before spawning yt-dlp.
- Add security headers via `apps/web/next.config.ts` `async headers()` (preferred — simplest, no Clerk-middleware entanglement), OR extend an existing `middleware.ts`.

**Out of scope**:
- Rate limiting (separate concern, larger effort — not this plan).
- Do not change how RSS is parsed or how yt-dlp downloads; only add a guard before them.
- Do not add new dependencies (`dns`/`net` are Node built-ins available in the worker; the web submission path validates format/scheme only).

## Steps

### Step 1: Shared URL guard

Create `packages/services/src/url-guard.ts`:

```ts
/** Rejects URLs that are not http(s) or that resolve to private/loopback/
 *  link-local ranges, to prevent SSRF from user-supplied feed/video URLs. */
export class UnsafeUrlError extends Error {
  constructor(public readonly reason: string) {
    super(`unsafe_url:${reason}`);
    this.name = "UnsafeUrlError";
  }
}

const PRIVATE_V4 = [
  /^127\./, /^10\./, /^169\.254\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./, /^0\./,
];

function isPrivateHostname(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h === "::1" || h === "0.0.0.0" || h === "[::1]") return true;
  if (PRIVATE_V4.some((re) => re.test(h))) return true;
  // IPv6 ULA / link-local
  if (/^\[?f[cd][0-9a-f]{2}:/i.test(h) || /^\[?fe80:/i.test(h)) return true;
  return false;
}

/** Structural validation (scheme + obvious private literals). Throws UnsafeUrlError. */
export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("invalid_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError("bad_scheme");
  }
  if (isPrivateHostname(url.hostname)) {
    throw new UnsafeUrlError("private_host");
  }
  return url;
}
```

Optionally (worker only, best-effort) add a DNS-resolution check that rejects
when the hostname resolves to a private IP — but keep the structural check as
the always-on guard. If you add DNS resolution, use `node:dns/promises` and do
not block the whole pipeline on a DNS failure (treat DNS error as "cannot
verify" → reject with `dns_failed`).

Export from `packages/services/src/index.ts` (`export * from "./url-guard";`).

**Verify**: `bun run typecheck` → exit 0.

### Step 2: Guard RSS fetch

In `packages/services/src/rss.ts`, at the top of `fetchRssEpisodes`, call
`assertPublicHttpUrl(rssUrl)` before `fetch`. Let `UnsafeUrlError` propagate
(callers already map thrown errors to a failed ingest state).

**Verify**: `grep -n "assertPublicHttpUrl" packages/services/src/rss.ts` → matched.

### Step 3: Guard YouTube ingest

In `apps/worker/src/tasks/ingest.ts`, before spawning `yt-dlp` with the user
URL, call `assertPublicHttpUrl(youtubeUrl)` (import from `@narriflow/services`).
Additionally require the host to be a known YouTube host — a tight allowlist is
appropriate here since this path is specifically "YouTube import":

```ts
const url = assertPublicHttpUrl(youtubeUrl);
const okHost = /(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(url.hostname);
if (!okHost) throw new IngestWorkerError("ingest_unsupported_source", "Only YouTube URLs are supported for this import type.");
```

Match the existing error-throwing convention in that file (find the existing
`IngestWorkerError`/`WorkflowWorkerError` class name and reuse it; if the error
code enum is validated elsewhere, pick an existing appropriate code rather than
inventing one — STOP and report if unsure).

**Verify**: `grep -n "assertPublicHttpUrl" apps/worker/src/tasks/ingest.ts` → matched. `bun run typecheck` → exit 0.

### Step 4: Security headers

Add to `apps/web/next.config.ts` an `async headers()` returning these on all
routes (`source: "/:path*"`):

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`

For CSP, use a **report-friendly, non-breaking** policy. Clerk, R2 presigned
media, and inline styles from Chakra must keep working, so do NOT ship a strict
`script-src 'self'` that could break Clerk. Start with `frame-ancestors 'none'`
(the enforceable clickjacking win) and leave a commented TODO for a full
`script-src`/`connect-src` policy once the exact Clerk/R2/analytics origins are
enumerated. Concretely set:

```
Content-Security-Policy: frame-ancestors 'none';
```

Keep the existing `next.config.ts` config (image `remotePatterns`, etc.) intact —
only add the `headers()` function.

**Verify**: `bun run typecheck` → exit 0. If a dev server is available,
`curl -sI http://localhost:3000/ | grep -i "x-frame-options\|content-security"`
shows the headers (optional — skip if no server).

## Test plan

- `packages/services/src/url-guard.test.ts` (model after `caption-preset.test.ts`, `bun:test`):
  - accepts `https://feeds.example.com/podcast.xml` (returns a URL).
  - rejects `http://169.254.169.254/latest/meta-data/` (`private_host`).
  - rejects `http://localhost:5432/` and `http://127.0.0.1/`.
  - rejects `file:///etc/passwd` and `ftp://x/` (`bad_scheme`).
  - rejects `not a url` (`invalid_url`).
- Verification: `bun run test` → all pass including new cases.

## Done criteria

- [ ] `bun run typecheck` exits 0
- [ ] `bun run test` exits 0; `url-guard.test.ts` passes
- [ ] `grep -n "assertPublicHttpUrl" packages/services/src/rss.ts apps/worker/src/tasks/ingest.ts` → both matched
- [ ] `grep -n "X-Frame-Options\|frame-ancestors" apps/web/next.config.ts` → matched
- [ ] No files outside scope modified (`git status`)

## STOP conditions

- `apps/web/next.config.ts` already has a `headers()` function — merge into it, don't duplicate; if the structure is unfamiliar, report.
- The ingest error-code set is a validated enum and none fits "unsupported source" — STOP and report which codes exist.
- Adding CSP breaks the dev server (Clerk/login fails) — revert the CSP line, keep the other headers, and report.

## Maintenance notes

- The CSP is intentionally minimal (`frame-ancestors 'none'` only). Follow-up: enumerate Clerk/R2/analytics origins and tighten `script-src`/`connect-src`/`img-src`/`media-src`.
- The structural SSRF guard does not do DNS rebinding protection; if that threat matters later, add resolve-then-pin fetching in the worker.
