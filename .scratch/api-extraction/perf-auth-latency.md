# Authenticated request latency (2026-10-29)

Measured in-process against the real production app (`createProductionApp`, Neon dev, Upstash dev, Clerk dev
Bearer minted for the QA user, token never printed). Neon round trip from this machine: **~245 ms per query**
(`select 1`), Upstash INCR ~260 ms, first Redis call ~1.3 s (handshake). Production (same-region) RTT is ~2 ms, so
the *number of sequential waves* is what to minimise, not the milliseconds.

## Step breakdown of one warm authenticated request (before)

| Step | Cost | Notes |
| --- | --- | --- |
| Clerk token verification | 1-3 ms warm (56-102 ms first call = JWKS fetch) | networkless after warm-up; no change needed |
| Clerk directory refresh (`needsUserRefresh`) | 0 | not called on the hot path for a complete user |
| App User load + personal-Workspace check | 3 sequential queries, ~735 ms | user, owner membership, then its Workspace |
| Selected membership + Workspace | 2 sequential queries (Prisma `include` is not a join here), ~495 ms | |
| Rate limit (1 rule) | 1 Redis RTT, ~260 ms | per rule, sequential by design |
| Project admission (project routes) | 3 sequential queries (project, workspace, members) | |
| Admission total before handler | **5 DB waves + 1 Redis = ~1.5 s** | |

## Changes

- `packages/auth/src/identity.ts`: `getAppUserForClerkIdentity` reads the user row and the personal-Workspace
  invariant together (1 wave, no writes when fresh). New `readWorkspaceRequestActor`: user + selected membership +
  Workspace + personal invariant in one wave keyed by the verified Clerk id; returns null (never decides) when
  anything needs provisioning, refreshing or refusing, and the existing two-step path then runs.
- `packages/auth/src/workspace.ts`: membership + Workspace are two single-table reads issued together instead of an
  `include` (2 waves to 1); same for the personal fallback.
- `apps/api/src/http/request-policy-runtime.ts`: `workspace()` uses the single-read path first.
- `apps/api/src/http/request-policy.ts`: the Project read starts right after the capability checks and overlaps the
  limiter. Decision order unchanged (a 429 still beats a missing Project; an unused read is discarded).
- `apps/api/src/http/project-admission.ts`: one single-table query (membership is a filter); the Workspace name is read only
  to explain a mismatch.
- Malformed `X-Workspace-Id` (non-UUID) is now 400 `invalid_input`; a valid but removed selection stays 409
  (`isWorkspaceHint`, wired in production).
- Session bootstrap now carries `usage` (null when the member cannot view the Workspace). `SessionGate` seeds the
  Workspace bootstrap and usage caches from it (`seedWorkspaceBootstrapFromSession`) before adopting the Workspace, so
  `WorkspaceQueryGate` makes no second request. The scope-before-scoped-queries rule is intact: seeding is a cache
  write, every scoped request still waits for adoption. `GET /workspace/bootstrap` remains for refreshes and the
  paused-Workspace refusal.

## Before / after (warm, local, RTT 245 ms)

| | Before | After |
| --- | --- | --- |
| Admission DB waves (Workspace route) | 5 (5 queries) | 1 (4 parallel queries) |
| Admission DB waves (identity-only route) | 3 | 1 |
| Project admission queries | 3 sequential | 1 (2 only on mismatch), overlapped with the limiter |
| `GET /workspace/bootstrap` | 3.1-4.0 s (15 queries) | 1.5 s (14 queries, 7 waves incl. handler) |
| `GET /billing/state` | 2.9 s | 1.3 s |
| `GET /home` | not measured (aggregate) | 1.5 s |
| `GET /session/bootstrap` | 2.6 s | 1.7 s (now includes usage) |
| Shell chain session -> workspace bootstrap | 2.6 + 3.1-4.0 = 5.7-6.6 s | 1.7 s (one request) |
| Shell + first page query (home) | ~8-9 s | ~3.2 s |

Test evidence: `packages/auth/test-fixtures/personal-workspace-auth.ts` counts simulated round trips (warm Workspace
request = 1 round trip / 4 queries / no writes; full path = 1 per step); `request-policy.test.ts` (overlap and order),
`project-admission.test.ts`, `request-policy-runtime.test.ts` (fast path, fallback, 400 vs 409), session route tests
(usage), `workspace.test.ts` in api-client (seeding).

## Not done / next levers

- Remaining ~1 s of a request is handler waves from Prisma `include` (each is 2 sequential queries): `listUserWorkspaces`,
  `getAvatarUrls`, `requireActor`, usage. Enabling `previewFeatures = ["relationJoins"]` in `packages/db/prisma/schema.prisma`
  (+ generate, no migration) and `relationLoadStrategy: "join"` on hot reads would halve those; it touches the shared generated
  client, so it was not done while other agents run against it.
- The limiter key needs the resolved actor, so it cannot start before the admission wave; speculative or concurrent
  multi-rule checks were rejected (a refused request would burn later, shared buckets).
- `bun test apps/api/src packages/auth` in one process fails 4 "REST v1 clip timelines" tests: pre-existing `mock.module`
  leakage from the auth fixture (reproduced with my auth changes stashed); each suite passes alone and under turbo.
