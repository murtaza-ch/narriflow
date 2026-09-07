# Plan 037: Bound optional Redis failures without stale live state

> **Reopened 2026-07-10**: Durable workflow fallback is implemented, but fresh
> verification proved the configured rate limiter never reaches a healthy Redis
> connection. Complete the connection/test addendum before marking this done.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plan 032
- **Category**: reliability, observability, secret hygiene
- **Planned at**: commit `05d273d`, 2026-07-10, live working tree
- **Result**: REOPENED — the original 13 focused tests and aggregate pass, but
  they test only absent/malformed Redis for the limiter. `lazyConnect: true`
  plus `enableOfflineQueue: false` rejects the first command before connection,
  so configured rate limiting permanently fails open.

## Why this matters

Browser QA exposed an unreachable optional Redis endpoint reconnecting forever
and emitting unhandled ioredis errors containing its hostname. The workflow
publisher and SSE subscriber also had unbounded waits/reconnect behavior. A
naive retry cap would have created a worse failure: an SSE connection that
continued heartbeating but never delivered new durable events.

## Scope

- `packages/services/src/optional-redis.ts` and its tests
- `packages/services/src/rate-limit.ts` and its tests
- `packages/services/src/workflow.service.ts`
- `packages/services/src/index.ts`
- `apps/web/app/api/stream/[projectId]/route.ts`
- `apps/web/lib/workflow-stream.ts` and its tests

## Implemented invariants

1. Validate Redis URLs without logging credentials; attach an error listener
   before any network operation and emit only allow-listed diagnostic codes.
2. Bound connect, command, and reconnect attempts. Reset stalled singletons by
   identity and use a recovery cooldown instead of an infinite hot loop.
3. Preserve the rate limiter's explicit fail-open policy. Redis never becomes
   a hidden dependency of core request availability.
4. Persist workflow events before best-effort publication. A publisher outage
   emits one redacted warning per outage window and cannot reverse domain state.
5. Replay durable events before subscribing, validate Pub/Sub events against
   the shared schema and project, serialize sequence gaps through Postgres, and
   fall back to non-overlapping 15-second DB polling only while Redis is absent
   or exhausted.
6. Register abort cleanup before async SSE setup and clear every heartbeat,
   poller, listener, and subscriber on disconnect/cancel.

## Re-verification defect and remediation

`packages/services/src/rate-limit.ts:29-36` creates a lazy client with the
offline queue disabled, then `checkRateLimit` calls `INCR` without first awaiting
`connect()` (`rate-limit.ts:68-76`). A direct local probe reproduces ioredis's
`Stream isn't writeable and enableOfflineQueue options is false` rejection. The
catch disconnects/resets the client and returns `allowed: true`; after cooldown,
the same sequence repeats. A valid configured Redis therefore applies no abuse
limit.

Official ioredis behavior:
<https://github.com/redis/ioredis#connection-events> and
<https://github.com/redis/ioredis#offline-queue>.

Remediation:

1. Introduce one identity-bound, shared, bounded connection promise. Explicitly
   await `connect()`/ready before issuing a command when the client is `wait`/
   connecting. Concurrent first requests must share one connection attempt.
2. Preserve the intentional fail-open response only for a real unavailable/
   timed-out Redis outcome. On failure, reset exactly that client, enter the
   existing cooldown, and never leak its URL/error text.
3. Avoid a race where one caller disconnects a client another caller has already
   replaced or connected. Clear connection promise/client by identity.
4. Add injectable-client or ephemeral-Redis tests for healthy first connection,
   count/expiry/limit behavior, concurrent first calls, connection failure,
   command timeout, reset/cooldown and recovery. Existing absent/malformed URL
   tests remain.
5. Add direct SSE orchestration tests for Redis failure/end/gap/buffer
   exhaustion, abort cleanup and exactly one database poller. Cursor-helper-only
   tests are insufficient for the implemented fallback state machine.

## Done criteria

- [x] Unreachable Redis cannot reconnect or wait forever.
- [x] Redis errors cannot implicitly log connection URLs or credentials.
- [ ] Configured healthy Redis connects before the first command and enforces
  the counter/limit; unavailable Redis still fails open quickly and cools down.
- [x] Redis loss cannot leave a connected-but-stale project stream.
- [x] Malformed, cross-project, duplicate, and gapped Pub/Sub events cannot
  poison the SSE cursor.
- [ ] Healthy/failing/concurrent Redis limiter tests, SSE orchestration tests,
  focused gates and the full aggregate pass.

## Residual decisions

- Rate limiting is intentionally fail-open; changing abuse-control policy to
  fail-closed or local fallback needs an explicit availability decision.
- Plan 027 remains the production migration for atomic event sequencing,
  leases, and a transactional outbox under multi-worker concurrency.
