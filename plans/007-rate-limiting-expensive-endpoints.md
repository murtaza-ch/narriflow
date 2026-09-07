# Plan 007: Rate limiting on expensive endpoints

> **Executor**: follow step by step, verify each step. STOP if excerpts don't match.
> **Drift check**: `git status --short packages/services apps/web/app/api` — uncommitted tree; excerpts from disk.

## Status
- **Priority**: P2 · **Effort**: M · **Risk**: MED · **Depends on**: none
- **Category**: security · **Planned at**: `05d273d`, 2026-07-06

## Why this matters
Expensive endpoints (clip generation, render, dubbing, content-suite, social
post creation, upload presign) authenticate the user but have **no rate
limiting**. A logged-in user (or a leaked session) can hammer them, driving
OpenAI/AssemblyAI/FFmpeg cost and R2 writes. Quota gates cover *processing
minutes* but not request frequency (e.g. spamming presign or content-suite).
A lightweight per-user limiter closes this cheaply using the Redis already in the
stack (`ioredis`, `UPSTASH_REDIS_URL`).

## Current state (verified)
- Redis client: `packages/services/src/workflow.service.ts:1` `import Redis from "ioredis"`, configured from `process.env.UPSTASH_REDIS_URL`. Reuse this provider (do NOT add `@upstash/ratelimit` or any new dependency).
- API routes are Hono handlers in `apps/web/app/api/[[...route]]/route.ts`. Each expensive handler follows this shape (from `/projects/:id/generate`, line ~208):
  ```ts
  app.post("/projects/:id/generate", async (c) => {
    const appUser = await getCurrentAppUser();
    if (!appUser) return c.json({ error: "Unauthorized" }, 401);
    ...
  ```
- Expensive endpoints (line numbers approximate): `POST /projects/:id/generate` (~208), `POST /projects/:id/clips/regenerate` (~763), `POST /projects/:id/clips/render` (~812), `POST /projects/:id/content-suite` (~1013), `POST /projects/:id/social-posts` (~1198), `POST /projects/:id/dubs` (~1311), and the upload presign endpoint (search `presign`).

Conventions: services re-exported from `packages/services/src/index.ts`; return typed results; degrade gracefully when Redis is down (workflow pub already swallows Redis errors — the limiter must **fail open**, never block a legit request because Redis is unreachable).

## Commands
| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Tests | `bun run test` | all pass |

## Scope
**In scope**:
- Create `packages/services/src/rate-limit.ts` + export from `packages/services/src/index.ts`.
- Create `packages/services/src/rate-limit.test.ts`.
- Modify `apps/web/app/api/[[...route]]/route.ts` to call the limiter at the top of the expensive handlers listed above (after auth, before the work).

**Out of scope**: webhook endpoints (Stripe/Clerk verify signatures — different concern), GET/list endpoints, any change to quota logic, adding dependencies.

## Steps

### Step 1: Redis-backed fixed-window limiter (fail-open)
Create `packages/services/src/rate-limit.ts`:

```ts
import Redis from "ioredis";

let client: Redis | null = null;
function getClient(): Redis | null {
  const url = process.env.UPSTASH_REDIS_URL;
  if (!url) return null;
  if (!client) {
    client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
    client.on("error", () => { /* handled per-call; fail open */ });
  }
  return client;
}

export interface RateLimitResult { allowed: boolean; remaining: number; limit: number; }

/** Fixed-window per-key limiter. Fails OPEN (allowed=true) if Redis is
 *  unavailable — availability must not depend on the limiter. */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const redis = getClient();
  if (!redis) return { allowed: true, remaining: limit, limit };
  try {
    const bucket = `ratelimit:${key}:${Math.floor(Date.now() / 1000 / windowSeconds)}`;
    const count = await redis.incr(bucket);
    if (count === 1) await redis.expire(bucket, windowSeconds);
    return { allowed: count <= limit, remaining: Math.max(0, limit - count), limit };
  } catch {
    return { allowed: true, remaining: limit, limit };
  }
}
```

Note: `Date.now()` is fine in application runtime code (the no-`Date.now` rule
applies only to Workflow scripts, not to this service). Export from
`packages/services/src/index.ts` (`export * from "./rate-limit";`).

**Verify**: `bun run typecheck` → 0.

### Step 2: Apply to expensive handlers
At the top of each expensive handler (immediately after the `appUser` auth check
and before doing work), add:

```ts
const rl = await checkRateLimit(`gen:${appUser.id}`, 20, 60); // tune per endpoint
if (!rl.allowed) {
  return c.json({ error: "rate_limited", message: "Too many requests. Please wait a moment and try again." }, 429);
}
```

Use a distinct key prefix + sensible limit per endpoint (generous enough for
normal use, e.g. generate/regenerate/render/dub: 20/min; content-suite: 30/min;
social-posts: 30/min; presign: 60/min). Keep the `429` body shape consistent so
the client error map (`userErrorMessage`) can show it — also add
`rate_limited: "Too many requests. Please slow down and try again."` to
`packages/validators/src/error-messages.ts` **only if** you can do it without
expanding scope beyond a one-line map entry; otherwise leave the inline message.

**Verify**: `grep -c "checkRateLimit" apps/web/app/api/[[...route]]/route.ts` ≥ 5; `bun run typecheck` → 0.

## Test plan
- `packages/services/src/rate-limit.test.ts` (model after `url-guard.test.ts`, `bun:test`): with `UPSTASH_REDIS_URL` unset, `checkRateLimit` returns `allowed: true` (fail-open) every call — this is the critical safety property and is testable without a live Redis. Assert `remaining`/`limit` shape.
- Do NOT stand up a real Redis in tests.
- Verify: `bun run test` → all pass incl. new file.

## Done criteria
- [ ] `bun run typecheck` exits 0; `bun run test` exits 0 with new test passing
- [ ] `grep -c "checkRateLimit" apps/web/app/api/[[...route]]/route.ts` ≥ 5
- [ ] Limiter fails open when `UPSTASH_REDIS_URL` is unset (asserted in test)
- [ ] Only in-scope files modified (`git status`)

## STOP conditions
- The route handlers don't share the `appUser` auth shape shown above → report; don't guess the user id source.
- Adding a new Redis connection conflicts with an existing shared client export in services → reuse the existing one instead and note it.

## Maintenance notes
- Limits are per-user fixed-window; if abuse via many accounts appears, add a per-IP limiter at the edge/middleware layer.
- Reviewer: confirm the limiter is called AFTER auth (so anonymous requests 401 first) and that it fails open.
