# Plan 011: Tighten CSP in Report-Only mode

> **Executor**: follow step by step, verify each step. STOP if excerpts don't match.
> **Drift check**: `git status --short apps/web/next.config.ts` — uncommitted; excerpts from disk.

## Status
- **Priority**: P3 · **Effort**: S · **Risk**: LOW (Report-Only cannot break the app) · **Depends on**: plan 002 (headers block exists)
- **Category**: security · **Planned at**: `05d273d`, 2026-07-06

## Why this matters
Plan 002 added an enforced `Content-Security-Policy: frame-ancestors 'none'`
(clickjacking protection) but intentionally deferred a full `script-src`/
`connect-src` policy because tightening it blindly could break Clerk auth or R2
media. The safe way to progress is a **Report-Only** CSP: the browser evaluates
a stricter policy and reports violations but never blocks anything. This lets the
team see exactly what a strict policy would break before enforcing it — security
maturity with zero risk to production.

## Current state (verified)
- `apps/web/next.config.ts` has an `async headers()` block (added by plan 002)
  returning, among others, `Content-Security-Policy: frame-ancestors 'none';` on
  `source: "/:path*"`. Confirm: `grep -n "frame-ancestors\|headers()" apps/web/next.config.ts`.
- Auth is Clerk (loads scripts/frames from `*.clerk.accounts.dev` / `*.clerk.com`
  and posts to Clerk APIs). Media is Cloudflare R2 presigned URLs (`*.r2.cloudflarestorage.com`
  and/or a custom domain). Images may also come from YouTube thumbnails
  (`i.ytimg.com`) — check `images.remotePatterns` in the same file for the exact
  hosts already whitelisted and reuse them.

## Commands
| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Tests | `bun run test` | all pass |

## Scope
**In scope**: `apps/web/next.config.ts` only — add ONE additional header,
`Content-Security-Policy-Report-Only`, alongside the existing enforced headers.

**Out of scope**: do NOT change or tighten the *enforced* `Content-Security-Policy`
(leave `frame-ancestors 'none'` as-is); do NOT add a violation-report endpoint
in this plan (note as follow-up); no other files.

## Steps

### Step 1: Add a Report-Only CSP
In the same `headers()` array entry, add a `Content-Security-Policy-Report-Only`
header with a reasonably strict policy that reflects the app's real origins.
Derive the exact hosts from the existing `images.remotePatterns` and the Clerk
env (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` implies the Clerk frontend API host).
A sensible starting policy (adjust hosts to what the config already whitelists):

```
default-src 'self';
base-uri 'self';
object-src 'none';
frame-ancestors 'none';
img-src 'self' data: blob: https:;
media-src 'self' blob: https:;
font-src 'self' data:;
style-src 'self' 'unsafe-inline';
script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.clerk.accounts.dev https://*.clerk.com;
connect-src 'self' https://*.clerk.accounts.dev https://*.clerk.com https://*.r2.cloudflarestorage.com https://*.upstash.io;
frame-src 'self' https://*.clerk.accounts.dev https://*.clerk.com;
worker-src 'self' blob:;
```

Put it on a single header value (semicolon-separated, no newlines). Because it's
`-Report-Only`, nothing is blocked — mismatches only log to the browser console
/ any future report endpoint. Keep the enforced headers from plan 002 untouched.

**Verify**: `grep -n "Content-Security-Policy-Report-Only" apps/web/next.config.ts` → matched; `bun run typecheck` → exit 0.

## Test plan
- Config-only; gate on typecheck + suite staying green.
- If a dev server is available (optional): load the app, sign in via Clerk, open
  a clip, and check the browser console for CSP *report-only* violations — record
  which directives fire so a future enforced policy can be calibrated. Do not
  block on this.

## Done criteria
- [ ] `bun run typecheck` exits 0; `bun run test` exits 0
- [ ] `grep -n "Content-Security-Policy-Report-Only" apps/web/next.config.ts` → matched
- [ ] The enforced `Content-Security-Policy: frame-ancestors 'none'` is unchanged
- [ ] Only `apps/web/next.config.ts` modified (`git status`)

## STOP conditions
- The `headers()` block from plan 002 isn't present (drift) → STOP and report.
- The existing config's structure makes adding a second CSP header ambiguous → report rather than guess.

## Maintenance notes
- Follow-up: add a `report-to`/`report-uri` endpoint to collect violations, run
  in Report-Only for a week, then promote the calibrated policy to enforced
  `Content-Security-Policy` (replacing the minimal `frame-ancestors` one).
- Reviewer: confirm this is `-Report-Only` (non-blocking) and that Clerk/R2/Upstash hosts match what the app actually calls.
