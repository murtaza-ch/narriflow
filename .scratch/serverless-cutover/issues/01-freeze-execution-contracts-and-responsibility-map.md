# 01 - Freeze execution contracts and responsibility map

**What to build:** Freeze execution contracts and responsibility map
- **Build:** command/result schemas; lock order; epoch/generation/owner/lease/deadline semantics; dispatch inventory (§4.11); source/audio binding; deletion map. New ADR 0019 "Serverless execution". Amend 0001, 0003, 0004 (evidence transport), 0005, 0007, 0010, 0011, 0012, 0014 (delivery driver), 0017, 0018. Glossary terms.
- **Files:** `docs/adr/**`, `GLOSSARY.md`, `packages/validators/src/execution*.ts`.
- **Accept:** every loop has a trigger and destination. State diagrams cover ambiguous provider acceptance, response loss, cancel, restore and no-agent. Reuse patterns from cloudflare/workflows-starter, the DO hibernation example, modal-labs/modal-examples and yt-dlp, adding Narriflow's fences.

### 02. Single domain migration
- **Build:** `ExecutionDispatch`; durable inbox/delivery receipts; epoch/generation bindings; executor owner acquisition; explicit operation/submission/result deadlines; `SourceAudio` and source revision binding; due indexes; destination delivery facts replacing Redis-specific event columns. Explicit, reviewed dev reset list. Keep usage/refund audits, work-set membership, execution ledgers and publication receipts. No `SourceRange`.
- **Files:** `packages/db/prisma/schema.prisma`, one `migrations/*_serverless_execution/migration.sql`.
- **Accept:** fresh and dev-shaped DBs migrate on disposable databases only. Uniques, checks and indexes hold. Every removed claim field has a documented replacement predicate.

### 03. Database scope and API runtime on Workers
- **Build:** §4.4: engine-free Prisma with adapter-pg over Hyperdrive, scoped clients, Workers exports, `wrangler.jsonc`, raw-body webhooks, Clerk/API-key admission, W/A origins, REST, remote MCP, narrow exports.
- **Files:** `packages/db/src/{client,index}.ts`, `packages/db/package.json`, schema generator, `apps/api/src/{index,runtime,config,server-hooks}.ts`, `http/**`, domain runtimes, `apps/api/wrangler.jsonc`, `packages/services`/`mcp-core` exports, `bun.lock`.
- **Accept:** every mounted route runs under workerd. Inventory and OpenAPI pass. No binding or client crosses requests. Locks, rollback and raw SQL are proven through deployed uncached Hyperdrive. No native module in the final isolate graph (after 07/16/18).

### 04. Transactional dispatch and wake delivery
- **Build:** §4.1: outbox append/claim/ack/retry, immediate after-commit dispatcher, retryable acceptance, Workflow event delivery, hourly safety reconciler.
- **Files:** `packages/services/src/execution-dispatch{,-runtime}.ts`, producers, `apps/api/src/execution/**`, `apps/api/src/workflows/maintenance.ts`.
- **Accept:** crashes after commit, after create, or before ack lose nothing and duplicate nothing. Existing instances reconcile. Unregistered dispatches stay visible and retryable. No minute scan.

### 05. Lifecycle claimers and reapers → targeted commands
- **Build:** §4.2: exact-id acquire/renew/release/expire for ingest, Workflow Attempts, Render Groups and background jobs. DB time after locks, process-start charging, immutable work sets, short parent settlement, deadline registered before dispatch, epoch invalidation.
- **Files:** `packages/services/src/{ingest-job-lifecycle,workflow-run-lifecycle,render-group-lifecycle,layout-evidence,media-cleanup*}.ts` and their DB tests.
- **Accept:** one active owner. An expired owner can't renew or commit. Pre-start rejection is uncharged. Settlement happens once with no live or retryable groups. Targeted expiry and the hourly backstop share one transition.

### 06. Executor control API and Modal bridge
- **Build:** §4.3: signed commands, replay receipts, trust admission, scoped grants, Python spawn/status/cancel, TS RPC adapters for lifecycle ports.
- **Files:** `packages/validators/src/execution*.ts`, `apps/api/src/domains/execution/{routes,admission,runtime}.ts`, `packages/services/src/executor-control*.ts`, `apps/media/python/narriflow_media/{bridge,control}.py`.
- **Accept:** a wrong key, audience, path, body or age, or a conflicting replay, fails before mutation. An exact replay returns the prior disposition. A stale token fails. Spawn-ack loss and Modal rescheduling never run a duplicate heavy job. Commit with a lost callback-ack keeps the object and the wake.

### 07. 10 GiB multipart and safe pinning
- **Build:** §4.8 across browser, REST, MCP and CLI. Large conditional-read pin job. Exact recovery and cleanup. Transfer separated from signing.
- **Files:** `packages/validators/src/upload.ts`, `packages/services/src/{upload-session.service,r2-storage,ingest-job-lifecycle}.ts`, `apps/media/src/source-pin.ts`, ingest/REST/MCP adapters, `apps/mcp/src/upload.ts`, `packages/mcp-core` upload tools, `packages/api-client/src/ingest/**`, web upload, OpenAPI/docs.
- **Accept:** a 10 GiB auto transfer works with bounded memory, and >10 GiB is refused. A >5 GiB pin works without conditional `UploadPartCopy`. Overwrite, lost finalize, mutation during pin, abort and expired grants all behave per ADR 0005.

### 08. Link STT admission from verified Source Audio
- **Build:** §4.7: separate audio and video readiness, immutable binding, once-only settlement, whole-source cap/credit, mismatch handling with refund-needed evidence.
- **Files:** `packages/services/src/{processing-usage,ingest-job-lifecycle,workflow-run-lifecycle,project.service}.ts`, source artifact service, typed failures, DB tests.
- **Accept:** audio and video callbacks in either order, concurrency, a 60.01 s duration, month rollover, restriction, missing reservation, cap overflow and retry all debit exactly once. A mismatch blocks rendering. Source readiness stays truthful to clients.

### 09. Relocate TS media runtime and pin images
- **Build:** §4.5: move render/process/layout/preview/media modules, tests, fixtures, golden scripts, models and runtime lock to `apps/media`. Injected ports. Lean and render images. Python wrapper with signal forwarding and reaping.
- **Files:** `apps/worker/src/**` media modules → `apps/media/src/**`; `apps/worker/scripts/**`; `apps/media/{package.json,pyproject.toml,modal_app.py}`; image build definitions.
- **Accept:** no render behavior rewrite. Moved tests pass. Fixtures stay immutable. No moved module imports polling code or a DB default. Startup validates binaries, fonts and models. Cancellation reaps descendants.

### 10. Shared Python source downloader
- **Build:** §4.6: audio-first plus concurrent full video, identity/track manifest, pinned yt-dlp/Deno/token helper, config isolation, scoped multipart output, cap, finite retries, sticky HTTP proxy, strict egress. Direct/RSS/Drive/Zoom adapters keep guarded transport.
- **Files:** `apps/media/python/narriflow_media/{fetch,proxy,manifest}.py`, `apps/media/src/fetch-source.ts`, the normalized probe CLI, `modal_app.py`, fixtures.
- **Accept:** laptop-direct and Modal-proxy produce identical manifests for a frozen source. Audio commits before video. Proxy rotation stops at 3 sessions, never falls back to direct and never puts secrets in diagnostics. A controlled HTTP proxy fixture proves propagation through yt-dlp, FFmpeg and the token helper. The old TS downloader is deleted.

### 11. Laptop fetch agent without SQL polling
- **Build:** §4.6 local mode: dev-device session, `LocalFetchMailbox` DO, outbound agent, reconnect reconciliation, exact-id claims, active-only renewal, scoped uploads, offline capability.
- **Files:** `apps/api/src/durable-objects/local-fetch-mailbox.ts`, dev-only execution routes/admission, `apps/media/python/narriflow_media/local_agent.py`, root `fetch:local` script, link capability UI.
- **Accept:** a deployed Workflow completes a YouTube fetch through the Mac's IP. No inbound port and no DB credential. An idle connection makes zero SQL queries. Duplicate delivery, sleep, crash, expiry, cancel, stale upload and wrong Workspace are all tested. Production can't route to a device.

### 12. Scribe control as durable service steps
- **Build:** move `transcribe.ts` control into `packages/services/src/transcription*.ts` with persisted immutable audio. Native language extraction runs in Modal. Explicit-language and supplied-caption paths preserved. Targeted waits replace result sweeps. Concurrency is weighted.
- **Accept:** intent recorded before POST. Callback and GET share the finalizer. Duplicate or stale callbacks are no-ops. No full-video fallback for STT. No container or connection waits on transcription.

### 13. Parallel selection with one global finalization
- **Build:** move `detect-clips.ts` into `packages/services/src/clip-selection*.ts`. Bounded concurrent windows with per-window result references, then one global finalization. Prompt, settings and guidance semantics preserved.
- **Accept:** 2/4/6 windows for 1/2/3 h. Replay reuses committed windows without duplicate Clips. Cross-project token and request limits are fair, with explicit 429 backoff. No Workflow payload over 1 MiB.

### 14. ImportPipeline, RenderRun and OperationDriver
- **Build:** workflows that call domain commands, wait on audio/STT/video/prepare/group outcomes and settle the parent in short transactions. Explicit exports, regeneration, late follow-ups and caption-only imports use the same model. Preparation deduplicated per evidence binding.
- **Files:** `apps/api/src/workflows/{import-pipeline,render-run,operation-driver}.ts`, service adapters, the one-shot `render-group-executor`.
- **Accept:** events before waits, duplicates, cancelled generation, group expiry, mixed outcomes, partial retry and late exports are all handled. No `coordinateRenderWorkSet` loop. Results open only after the frozen batch settles, with a truthful partial outcome. Platform retries never multiply domain retry budgets.

### 15. Authorized hibernating progress
- **Build:** §4.9.
- **Files:** `apps/api/src/domains/progress/**`, `apps/api/src/durable-objects/project-progress.ts`, `packages/api-client/src/{core,progress}/**`, `apps/web/app/_components/api-provider.tsx`, progress consumers, `apps/web/next.config.ts`.
- **Accept:** unauthorized access, cross-scope access, wrong Origin, ticket replay, revocation, restriction, deletion and expiry during hibernation are all covered. No lost events across the subscribe/replay race. Buffers bounded. No DB polling on a healthy stream.

### 16. Remaining native deps, Redis rate limits and cache
- **Build:** §4.4 replacements: RateLimiter DO (fail-closed), Pexels cache, PBKDF2 passcodes, Modal-backed font/asset/thumbnail validation, Workers-safe storage/crypto exports.
- **Accept:** the Worker bundle can't reach Argon2, Sharp, FFmpeg, the font filesystem code or Redis. Passcode hashing is measured under workerd. Assets become usable only after validation.

### 17. Publication scheduling and provider execution
- **Build:** §4.10: revision-bound wakes, same-attempt reconciliation, claim/deadline commands, receipt enrichment, finite performance captures. Byte transfer in lean Bun Modal.
- **Accept:** editing or cancelling while asleep fences the old wake. A lost response at each irreversible boundary never triggers a blind create. Unrecoverable unknown → Needs attention. Zero duplicate posts across the failure matrix.

### 18. Callbacks, integration events, MCP stdio bridge
- **Build:** §4.10 delivery through guarded `outbound_delivery`. `apps/mcp` becomes an authenticated stdio→remote `/mcp` bridge with no DB or Redis.
- **Accept:** a slow receiver blocks only its own subscription. Cursors move only after a 2xx. DNS-rebinding, redirect, timeout and body-limit tests pass. MCP tools, resources, Apps and Tasks are unchanged.

### 19. Other product jobs and billing maintenance
- **Build:** event/due-driven drivers for billing, Autopilot/RSS, Finishing, dubbing, export bundles, generated media, thumbnails, library indexing, Performance Guidance and notification intents (existing email adapter untouched).
- **Accept:** a row-by-row map shows every old loop with its trigger, retry and expiry. Billing shares the usage lock. Stale rule or grant revisions can't authorize work. No quota double-spend on replay.

### 20. Bounded maintenance, cleanup and restore tooling
- **Build:** hourly safety reconciliation; daily retention, source purge, event/task cleanup, grant expiry and pending-workspace cleanup with durable continuation; exact-key Media Cleanup with holds; restore/epoch invalidation and redispatch procedure.
- **Accept:** an empty pass stops promptly. Referenced or held objects survive. After a restore, old executions can't commit and accepted obligations recover.

### 21. Linux media parity and crash correctness
- **Build:** run the relocated golden and fault harness on the pinned Modal image (render, audio extract, detectors, pinning, wrapper death, R2 and commit boundaries). Recover the render-hardening ticket 21 Linux reference, or rebuild a frozen pre-cutover reference with recorded provenance.
- **Accept:** exact normal comparisons, no baseline refresh and no invented tolerance. Evidence covers the camera-clock fix. SIGKILL after a sibling commit, spawn failure, lease loss, storage hang, full disk and lost commit-ack all preserve correct outcomes. Image boot and model readiness measured.

### 22. Integrated gates
- **Build:** run §7 against real deployed Workers, Workflows, DOs, Hyperdrive and Modal on isolated resources, with deterministic fault injection. Prove the laptop path and a controlled HTTP proxy.
- **Accept:** every gate passes with commands and raw evidence. Any correctness or platform failure blocks cutover.

### 23. Remove obsolete code; dev/CI/docs
- **Build:** the §6 deletion list. Move useful tests instead of dropping coverage. Update dev startup, `env:check`, CI, AGENTS.md, README and runbooks.
- **Accept:** a repo-wide search finds no polling scheduler, worker URL or obsolete dependency. Static and fast gates rerun on the exact deletion-inclusive SHA.

### 24. Execute the single cutover
- **Build:** the §8 runbook, with owner authorization for account, DNS and deletion steps. Record evidence in `docs/runbooks/serverless-cutover.md`.
- **Accept:** old consumers can't run against the migrated DB. Candidate and migration match the tested hashes. Smokes and idle check pass. Railway and Upstash are removed. Admission reopens once.

## 6. Deletion list (all in the same candidate)
- `apps/worker` as an app: `index.ts`, `poll-loop.ts`, health/poll-once server, loop drivers, the `coordinateRenderWorkSet` wait loop, the `workflow-attempt-executor` polling adapter, the host-global media scheduler and fleet restart machinery. Process safety, resource checks, exact-key cleanup and expiry transitions move to `apps/media`.
- Railway Docker/service config and CI deploy hooks; `Bun.serve`/SIGTERM lifecycle; filesystem readiness.
- Redis everywhere: `progress/redis.ts`, the SSE progress route/stream and SSE-only client transport (remote MCP keeps its HTTP streaming), `optional-redis.ts`, ioredis rate limiter/Pexels code, the `ioredis` dependency, Upstash and worker-health env vars.
- The old TS yt-dlp downloader (after the Python owner lands).
- The global `PrismaNeon` singleton and binary engine. Scan-only fields/indexes only where replaced. `@prisma/adapter-neon` unless a retained tool needs it.
- `apps/worker/.env` and worker dev wiring, replaced by `apps/api/.dev.vars`, web `.env.local`, the DB migration env and local-agent settings. No root `.env`.
- Never added: `SourceRange`, renderer selectors, dual readers/writers, shadow scheduling, legacy passcode verifier.

## 7. Verification gates
1. **Repo:** `bun run lint`, `typecheck`, `test`, API `test:inventory` + `openapi:check`, `check:web-split` (+ `--bundle` after the web build), `env:check`, the relocated media tests, Python tests, and a Wrangler dry-build import audit.
2. **Disposable Postgres:** every AGENTS.md DB gate plus new dispatch/deadline/audio-binding/inbox tests. Never against shared `narriflow-dev`.
3. **Real Workers DB:** transactions and locks through deployed uncached Hyperdrive, binding isolation, raw webhooks, auth (Clerk, API key, review passcode), signing and multipart, remote MCP, OpenAPI parity.
4. **Crash/replay:** inject failures at every boundary in §4.1–4.3. Result: zero duplicate debits, zero stale commits or deletions, one terminal parent transition, zero duplicate posts, bounded duplicate compute, and Scribe duplicate-bill risk reported separately.
5. **Transport/security:** signatures, replay, tickets, Origin/scope, hibernation expiry, gap reset, SSRF, body limits. DO keepalives never query Postgres.
6. **Storage/media:** exact Linux golden; 10 GiB multipart and conditional pin; local and controlled-proxy fetch; moov placement, GOP, VFR, H.265, A/V offsets, RTL/CJK/emoji, caption-only/audio-only, four targets, truncated outputs. Selected-window reads ≤20% of a 3 h source (excluding the initial full acquisition).
7. **Latency (12 clips, one 1080p target, all clips ready):** smoke test the 2m26s video at ≤4 min. Release targets: upload-after-transfer p50/p95 ≤5/12, 7/16, 9/20 min and YouTube Generate→ready ≤6/12, 9/18, 12/25 min for 1/2/3 h. Use ≥30 samples to explore and ≥100 per tail cohort before claiming p95. Whole-file Scribe; chunking is not part of this cutover.
8. **Quota/fairness:** at most 80 render containers within Starter, Scribe weighted units, LLM limits, Hyperdrive connection budget. Sustained peak plus 20/100-project bursts. Queue ETA or admission limits when quota is short.
9. **Idle/cost:** one hour with no traffic. Neon suspends between declared maintenance wakes, Modal is at zero containers, no continuous SQL (including Hyperdrive behavior, DO alarms and the idle laptop connection). Then measure cold first transaction, Modal cold readiness (target ≤5 s p50 / ≤20 s p95), per-job resources and egress.
10. **Restore and exact candidate:** isolated restore while old executions exist; the epoch bump blocks their commits; outbox replays safely. Rerun static gates on the release SHA.

## 8. Cutover runbook (ticket 24)
1. Verify the full deletion-inclusive candidate in isolated staging. Record SHA, migration hash, image fingerprint, Worker/Workflow versions, DO migration tag and rollback artifacts. One scheduler environment per database.
2. Prepare accounts, bindings, secrets, DNS and certificates. Keep the API hostname and switch its routing. Disable old Railway/Vercel push-to-deploy side effects.
3. Pause intake and irreversible publishing. Stop **all** old local and Railway workers and API mutations. Drain or fence active attempts. Reconcile uncertain provider effects. Revoke old consumer credentials.
4. Snapshot the DB, confirm the target via both connection variables, and apply the migration once (explicit reset list, new epoch).
5. Deploy the Modal functions and bridge, then the Worker, Workflows and DO migrations with admission closed. Validate Hyperdrive (cache off), R2 private access/CORS/lifecycle and secrets. Connect the dev laptop (`local` mode).
6. Switch API routing. Rebuild Vercel with `NEXT_PUBLIC_API_URL`, the `wss:` CSP and the media origin. Update provider callbacks, OAuth redirects, Clerk/MCP audience and integration clients. Playback through signed grants or an authenticated media Worker.
7. With admission paused, run smokes: upload, local YouTube audio/video overlap, Scribe callback, render batch, export, Studio evidence reuse, MCP/operation status, progress reconnect/revocation, publication recovery on sandbox destinations. Check outbox drain, single settlement and credits.
8. Live idle check, then a cold first request. Fix while admission stays closed.
9. Delete the Railway services/triggers/variables and the Upstash DB. Code deletions are already in the candidate.
10. Reopen admission once and record acceptance. **At launch:** set `YOUTUBE_FETCH_MODE=proxy` and the proxy secret, run the proxy gates and canary. No code change is needed.

**On failure:** keep intake closed, fence the candidate's executions and epoch, then fix forward or restore the snapshot together with the prior full release. Never run two schedulers.

## 9. Owner prerequisites and decisions (recommended answers)
1. **Cloudflare:** enable Workers Paid before the gates (free is fine during development), with scoped deploy access for Workers, Workflows, DOs, Hyperdrive, the existing R2 bucket and API DNS. **Yes.**
2. **Neon:** upgrade `narriflow-dev` to Launch, keep 5-minute suspend, allow a disposable test branch, and use a separate migration credential. **Yes.**
3. **Modal:** Starter workspace with a compute budget, per-function caps and `min_containers=0`. **Yes.**
4. **Dev laptop:** one allowlisted device and one test Workspace for local YouTube fetches. **Yes.**
5. **Proxy:** defer purchase. Ship the generic HTTP sticky-session contract tested against a controlled proxy, and pick the provider at launch after throughput and billable-byte tests. **Yes.**
6. **Keep the full original video** (no range-only downloads in this cutover). **Yes.** Range-only downloads would cut proxy cost by about 60–70% at scale, but they change the Editor Timeline and evidence contracts; revisit later as a separate product decision.
7. **Audio/video mismatch after settled usage:** keep the operator-only refund rule plus a refund-needed record. **Yes.**
8. **Progress revocation bound:** a 60 s ticket lifetime plus immediate revocation push replaces the 15 s SQL reauth. **Yes.**
9. **Dev reset:** reset execution/session/media fixtures, keeping identities, billing provider ids, keys and audits, from an explicit reviewed list. **Yes.**
10. **Secrets:** transfer the existing Clerk/Stripe/Scribe/OpenAI/social/encryption/callback secrets to the new runtimes via secret stores. Generate new execution-signing, connect-ticket and dev-device keys. Sentry and Resend untouched. **Yes.**
11. **Cutover authorization:** approve deployments, DNS/callback changes and the Railway/Upstash deletion only after reviewing the verified candidate. **Yes, at ticket 24.**.

**Blocked by:** none

**Status:** ready-for-agent

**Spec:** [Serverless cutover](../spec.md)



## Evidence

Pending implementation and verification.
