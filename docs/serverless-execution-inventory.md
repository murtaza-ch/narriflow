# Serverless execution responsibility map

This is the implementation contract for [ADR 0019](adr/0019-serverless-execution.md), frozen from `apps/worker/src/index.ts` at `aec2a9be`. It is an inventory, not evidence that the replacement is deployed. Domain services own every transition; Workflows invoke targeted commands and wait without retaining database or executor ownership.

| Existing loop | Transactional trigger / next due fact | Destination | Retry and expiry authority |
|---|---|---|---|
| `ingest` | Accepted Ingest Job dispatch; independent audio/video commits | ImportPipeline; local mailbox or Modal fetch/pin | Exact Ingest Claim, executor lease, 45-minute absolute fetch deadline; bounded domain retry |
| `maintenance` | Ingest handoff completion; known task/grant expiry; daily retention | ImportPipeline for handoff, bounded Maintenance for cleanup | Handoff identity and due fact; daily continuation; hourly gap backstop |
| `upload_session_maintenance` | Upload Session reservation/finalize/compensation/expiry commits | OperationDriver | Exact session state and generation; known grant expiry, idempotent provider recovery |
| `workflow_lease` | Child wake/deadline obligation before dispatch | Owning ImportPipeline, RenderRun or OperationDriver | Locked exact-token expiry, renewed lease reread; hourly bounded backstop uses same transition |
| `workflow_events` | Workflow Event commit plus destination dispatch obligations | ProjectProgress and interested OperationDrivers | Destination-specific ack/retry, immutable event identity and sequence |
| `completion_callbacks` | Accepted receipt registration; terminal lineage plus dispatch | OperationDriver to `outbound_delivery` | Same callback identity, bounded backoff/deadline; signed at-least-once notification |
| `webhook_deliveries` | Workspace Event flush; subscription admission/resume | Per-subscription OperationDriver to `outbound_delivery` | One leased cursor, advance after 2xx only; independent backoff/disable/retention gap |
| `pending_business_workspaces` | Pending provider reservation/known expiry | Daily bounded Maintenance | Billing cleanup idempotency and explicit expiry; durable continuation |
| `workspace_billing` | Verified Stripe delivery or due reconcile fact | OperationDriver | Current provider state, exact claim/deadline, usage lock, bounded provider retry |
| `stt` | Verified Source Audio admission or pinned-upload probe admission | ImportPipeline service step; Modal language probe | Intent before provider POST; weighted units; explicit submission/result deadlines |
| `stt_results` | Verified Scribe callback or correlated recovery due | ImportPipeline targeted finalizer | Accepted request identity distinct from transcription identity; same finalizer, no result sweep |
| `moment_detection` | Transcript finalization and per-window result commits | ImportPipeline bounded selection steps | Persisted window binding, request/token fairness and 429 backoff; one global finalization |
| `dubbing` | Dubbing admission and provider completion | OperationDriver; Modal `dub_mix` | Domain attempt, known provider wait identity, lease/operation deadlines |
| `export_bundle` | Export Bundle admission and dependency completion | OperationDriver; Modal `export_bundle` | Exact bundle generation, dependency wake, bounded native-operation deadline |
| `publish` | Post admission/edit/cancel schedule revision; provider callback | Revision-bound OperationDriver; lean Modal transfer | Same-attempt checkpoints and provider reconciliation, absolute deadlines, unknown to Needs attention |
| `performance_sync` | Publication receipt commits finite capture schedule | OperationDriver | Exact post/capture generation, bounded provider retries; no infinite capture loop |
| `performance_guidance` | Nightly bounded Workspace refresh obligations | Maintenance to OperationDriver | Workspace binding, bounded continuation and per-provider backoff |
| `autopilot` | Rule admission/edit commits next rule-revision wake | OperationDriver; guarded RSS fetch | Current rule/grant revision, quota under domain locks; finite next due and attempt deadline |
| `finishing` | Generation settlement commits Finishing due | OperationDriver | Frozen generation identity, access/plan reread, idempotent export/copy keys; exact lease/deadline |
| `render` | Frozen Render Work Set admission and child outcome wakes | RenderRun | Short locked parent settlement; no live/retryable groups; one terminal transition and follow-up obligation |
| `render_group` | Group admission/retry due after immutable partition | Modal `render_group` | Existing group token, owner, DB-time lease, charged-start ledger and three-charged-attempt budget |
| `preview` | Preview request with source/window/revision/engine binding | Deduplicated Modal `prepare_clip` through OperationDriver | Exact preparation binding, active lease/deadline, typed current degradation |
| `auto_layout` | Shared preparation request, missing evidence binding | Same deduplicated Modal `prepare_clip` | Evidence lifecycle revision/token fence, exact complete-window evidence; no separate detector queue |
| `notification_retry` | Terminal/review/paused-grant/disabled-subscription notification intent | OperationDriver with existing email adapter | Intent identity, exact claim, bounded backoff; email package unchanged |
| `media_cleanup` | Producer commits exact-key unreferenced obligation and holds | OperationDriver to lean Modal cleanup | Current cleanup token, reference/hold recheck, known grant expiry, bounded retry |
| `generated_media` | Generated media admission/provider result | OperationDriver and bounded media validation | Domain attempt/generation, provider deadline and immutable artifact binding |
| `thumbnail_frames` | Thumbnail admission or required source readiness | OperationDriver; Modal `thumbnail` | Exact source/revision/generation, native-process deadline; publish only validated artifact |
| `library_index` | Transcript completion/content hash change | OperationDriver | Exact transcript binding, per-provider backoff; no generation mutation on embedding failure |
| `render_executor_health` | Container startup and each admitted native job | Per-container readiness validation | Startup rejection uncharged, no fleet loop or periodic health polling |
| `render_resources` | Scratch creation and each native job's process lifetime | Per-container process/scratch owner | Resource ceilings, process-group kill/reap and scoped cleanup; no host-global scheduler |
| `render_objects` | Exact artifact commit/compensation obligations; hourly safety cursor | Bounded Maintenance to exact-key cleanup | Attempt-unique namespace, reference/hold checks, no stale inferred deletion |

Within `maintenance`, expired Workflow/Ingest claims use their targeted due transitions, not daily retention timing. MCP Tasks and Workspace Events retain their existing retention contracts; Standing Grant expiry commits its event and notification in the same transaction. Source purges, Project retention, session/grant expiry and pending Workspace cleanup use indexed bounded pages with durable continuations. Empty scans stop. The hourly backstop is recovery for abandoned obligations, not a fast-recovery SLA.

## Responsibilities that do not move

| Authority | Owner |
|---|---|
| Usage admission, settlement and operator refunds | Processing Usage service, Workspace usage lock before Project admission lock |
| Domain attempts, membership, charge budget and final outcomes | Existing Ingest/Workflow/Render Group/publication lifecycles, extended with exact-id commands |
| Execution-owner acquisition and signed inbox disposition | Executor control services, in the same transaction as affected domain state and wake |
| Captions and geometry | Shared composition plan, presets and cue derivation; single TS FFmpeg adapter |
| Database credentials and domain transition commits | Scoped API/Workflow TypeScript services only |
| Arbitrary URL egress and media byte transfer | Guarded lean Bun Modal function, not the Worker |
| Private storage object publication | Fenced API service after assigned-namespace checks and HEAD |
| Live transport caching and device presence | Hibernating DOs; no domain mutation authority and no idle SQL |

## Deletion map for the integrated candidate

| Removed path/dependency | Replacement retained in the same candidate |
|---|---|
| `apps/worker` app, entrypoint, poll-loop, poll-once/health server and fleet restart wiring | Targeted TypeScript services, Worker/Workflow/DO entrypoints and one-shot `apps/media` |
| `coordinateRenderWorkSet` wait loop, polling workflow executor, host-global media scheduler | RenderRun durable waits, exact-token child execution and per-container limits |
| Railway Docker/service config and CI deployment hooks, worker URLs and process signal API lifecycle | Wrangler bindings, Workers fetch/scheduled exports, Modal locked images and Vercel web |
| Redis progress, SSE route and SSE-only browser stream, optional Redis, ioredis rate/Pexels code and dependency | ProjectProgress hibernating sockets, RateLimiter DO and Cache API/R2 |
| TypeScript yt-dlp downloader | One shared Python acquisition library in laptop-direct and Modal-proxy modes |
| Global PrismaNeon singleton, binary engine and adapter-neon | Engine-free scoped Prisma adapter-pg through uncached direct-TLS Hyperdrive |
| API-reachable Argon2, Sharp, font filesystem, FFmpeg/native transfer imports | PBKDF2 WebCrypto, Modal validation/native operations and Worker storage control |
| DB-authenticated stdio MCP service wiring | Authenticated stdio bridge to remote `/mcp`, preserving tools/resources/Apps/Tasks |
| `apps/worker/.env` and four-file old dev startup contract | API `.dev.vars`, web public config, DB migration env and restricted local-device settings |
| Upstash database and Railway services, triggers and variables | Deleted only after exact-candidate gates, paused admission and successful new-runtime smokes |

No SourceRange, alternate renderer, dual read/write, compatibility passcode verifier or shadow scheduler is added. Linux media fixtures move unchanged and exact parity evidence must be recorded before deployment.
