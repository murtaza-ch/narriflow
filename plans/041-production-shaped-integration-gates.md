# Plan 041: Add production-shaped integration and provider-contract gates

> **Foundation plan**: Complete the smallest useful version before executing
> the stateful migrations in Plans 027 and 029–031. The goal is not a giant E2E
> suite; it is deterministic proof of the exact invariants that unit mocks and a
> successful build cannot exercise.
>
> **Drift check**:
> `git diff --stat 05d273d..HEAD -- .github/workflows package.json bun.lock packages/db packages/services apps/web/app/api apps/worker Dockerfile*`

## Status

- **Priority**: P1 release blocker/foundation
- **Effort**: L
- **Risk**: LOW
- **Confidence**: HIGH
- **Depends on**: none; worker-image job composes with Plan 038
- **Category**: tests, CI, database, contracts, reliability
- **Planned at**: commit `05d273d`, 2026-07-10, live working tree

## Why this matters

The current 233 tests are valuable but mostly pure/unit tests. The database
workspace's test script is a no-op (`packages/db/package.json:24`), and CI
provisions no Postgres service, applies no migrations, builds no worker image,
and runs no provider-adapter contract suite (`.github/workflows/ci.yml:19-35`).

The unresolved launch blockers specifically require real constraint,
transaction, concurrency, event-order, migration, and ambiguous-network
behavior. Without a production-shaped harness, Plans 027 and 029–031 cannot
satisfy their own STOP/done criteria, and a green aggregate can conceal broken
account deletion, stale billing access, duplicate external posts, or lost work.

## Target invariants

1. Every migration applies from empty schema and from a representative prior
   production shape, and schema drift fails CI.
2. PostgreSQL constraints/transactions—not mocks—prove admission, ownership,
   tenant boundaries, event ordering, deletion, and reconciliation behavior.
3. External adapters run against deterministic contract servers that model
   success, retryable/permanent failure, timeout-before-accept, timeout-after-
   accept, reordering, duplicates, rate limits, and malformed payloads.
4. The exact worker release image starts and completes local deterministic work.
5. Browser smoke covers the signed-in golden path and the highest-risk failure/
   recovery states without depending on live third-party accounts in every CI
   run.
6. Tests are isolated, parallel-safe, time-bounded, diagnosable, and never use
   production credentials/data.
7. Web/auth readiness validates that Clerk publishable and secret keys belong to
   the same environment before authenticated acceptance begins; a redirect loop
   is a failed gate, not a browser-test retry.

## Phase 1: Ephemeral PostgreSQL and migration gates

- Add a pinned PostgreSQL service/container matching production's supported
  major version and relevant extensions/settings.
- Create isolated database/schema per test worker; run migrations with the same
  Prisma command/config used for deployment.
- Add fixtures/builders for users, projects, uploads, workflows, clips, dubs,
  social accounts/posts, billing, brand snapshots, and deletion state. Use
  synthetic encrypted tokens/media metadata only.
- Gate empty-database deploy, upgrade from a checked representative prior
  schema, rollback/forward-fix documentation, and `migrate diff/status` drift.
- Record query plans for claim/reaper/calendar queries once their indexes land;
  fail on missing expected indexes rather than brittle absolute timings.

Do not commit a production dump. A representative schema/data fixture must be
privacy-safe, minimized, and generated from code.

## Phase 2: Core service integration suites

Create targeted suites for:

- workflow admission race, lease claim/heartbeat/expiry, late owner, child work,
  outbox/event sequence, partial outcome, and bounded SSE replay (Plan 027);
- multipart authorization/resume/completion/reconciliation/sweep (Plan 039);
- Stripe event claim and authoritative reconciliation under every shuffled/
  duplicated sequence (Plan 029);
- Clerk create/update/delete reordering, quiesce, revocation, object deletion,
  checkpoint restart, and tombstone protection (Plan 030);
- social publish claim, provider acceptance ambiguity, lookup/reconcile, safe
  retry, and metrics-after-publish failure (Plan 031);
- social token keyring rotation and concurrent refresh (Plan 040);
- workspace/project/user tenant-negative matrices for every changed path.

Use barriers/advisory locks or coordinated promises to create real concurrency;
do not rely on arbitrary sleeps. Freeze/control time for lease, grace, retention,
and scheduling behavior.

## Phase 3: Provider-adapter contract servers

Extract or formalize thin interfaces around Stripe, Clerk webhook delivery,
AssemblyAI, OpenAI, R2/S3, RSS/remote media, and each social provider. Build
local HTTP contract servers/fixtures that can deterministically return:

- accepted/completed;
- explicit retryable and permanent failures;
- 429 with retry guidance;
- slow/timeout before request acceptance;
- accepted response lost/timeout after an irreversible mutation;
- duplicate and reordered webhooks/statuses;
- malformed/partial success payloads and expired credentials;
- redirect/DNS/body-limit cases for remote input.

The contracts must assert Narriflow's request schema, headers, idempotency key,
timeouts, and response classification without copying entire vendor SDKs. Run a
smaller scheduled sandbox suite against real provider test accounts to catch
vendor drift; never make live publishing/billing mutations from pull requests.

## Phase 4: Worker image and media fixtures

After Plan 038's secure image exists:

- build/start the exact image in CI;
- connect it to the ephemeral database and local contract/object servers;
- process tiny licensed/generated media fixtures through ingest/transcription
  normalization/detection/render metadata paths with provider calls stubbed at
  the HTTP boundary;
- verify shutdown/restart, stale lease recovery, temp cleanup, font/glyph
  discovery, FFmpeg/ffprobe, and deterministic asset metadata;
- preserve only compact failure artifacts/logs, never generated secrets/tokens.

## Phase 5: Authenticated browser acceptance suite

Use a test-only Clerk strategy/session fixture consistent with Clerk's supported
testing guidance. Cover at minimum:

1. sign in/onboard;
2. create/upload or URL ingest;
3. source-language selection and low-confidence review state;
4. progress reconnect/fallback;
5. candidate review/edit/save/navigation-loss guard;
6. render/download and failure retry;
7. schedule/post-now/reconciling states with local social adapter;
8. billing status and account deletion/quiesce state.

Capture desktop and mobile public/core-shell screenshots and accessibility
snapshots for regression triage. Do not claim full WCAG conformance from this
suite.

Add a staging/local preflight that safely verifies Clerk key/environment parity
without printing keys. The current local acceptance environment logs an
infinite session-refresh redirect loop caused by mismatched instance keys; the
suite must fail fast with one actionable configuration error.

## CI topology and budgets

- **Every PR**: frozen install, current source gates, empty DB migrations,
  targeted integration suites, secure image build/smoke, small authenticated
  golden path.
- **Main/nightly**: representative upgrade migration, full concurrency/fault
  matrix, provider sandbox reads/test mutations, multilingual/media golden
  fixtures, dependency/image scans.
- **Pre-release manual gate**: production-like staging deployment, rollback
  rehearsal, real provider test accounts, browser matrix, backup/restore.

Set explicit per-test/request/global timeouts. Quarantine only with an owner,
reason, expiry date, and linked defect; do not normalize a permanently flaky
release gate.

## Test-data and security requirements

- Synthetic identities, tokens, account IDs, webhooks, media, and invoices only.
- No production database URL, provider live key, or user media available to CI.
- Logs redact authorization, cookies, signatures, OAuth codes/tokens, raw
  transcript PII, storage keys, and provider bodies by default.
- Network egress denied for the deterministic suite except pinned package/image
  setup; real sandbox jobs are isolated and explicitly authorized.

## Done criteria

- [ ] Database tests are no longer a no-op.
- [ ] CI applies migrations to empty and representative prior schemas and fails
  on drift.
- [ ] Plans 027 and 029–031 invariants have real-Postgres concurrency/fault tests.
- [ ] Provider adapters classify explicit and ambiguous outcomes through local
  contract fixtures.
- [ ] The secure worker image starts and processes deterministic media/workflow
  fixtures in CI.
- [ ] A signed-in golden path plus critical recovery states run without live
  production providers.
- [ ] Clerk environment/key mismatch fails preflight before browser execution;
  no redirect-looping run can report a pass.
- [ ] Nightly sandbox drift checks have owners and safe credentials/scopes.
- [ ] Test logs/artifacts contain no secret or production-user data.

## STOP conditions

- CI would require production credentials, live social publishing, or production
  customer data.
- Concurrency tests use sleeps instead of controllable synchronization and fail
  nondeterministically twice.
- Provider fixtures test private implementation details rather than public
  request/outcome contracts.
- The harness attempts to reimplement every vendor instead of covering the
  small failure matrix Narriflow must classify.
- A migration cannot be exercised from a privacy-safe representative shape.
- The project tries to execute Plans 027 or 029–031 before their required
  integration invariants can be tested.
