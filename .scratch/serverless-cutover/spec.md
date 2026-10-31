# Serverless cutover: one build, one switch, no legacy

**Status:** final plan, ready for implementation (2026-10-31)

## 1. Goal and constraints

Move Narriflow from always-on Railway processes (an API plus a worker with about 30 polling loops) to an event-driven, scale-to-zero system. It must be fast for 1–3 hour podcasts and cost close to nothing when idle.

Binding constraints:
- **No legacy.** There are no production users. Old paths are deleted in the same change, with no dual paths, shadow schedulers, compatibility shims or legacy verifiers (AGENTS.md pre-production policy).
- **One integrated build and one cutover.** The tickets below have dependency edges so work can run in parallel, but they ship together as one deletion-inclusive release. They are not phased product releases.
- **No residential proxy yet.** In development, YouTube is downloaded on the developer's machine and network. The proxy path is fully implemented and switched on by configuration at launch.
- **Out of scope:** Sentry and Resend. The existing `packages/email` code is untouched.
- **Python is allowed where it is the better tool** (decision in §4.5).

## 2. Target system

```
Browser ──> Vercel (apps/web, Next.js)
   ├─ direct multipart upload / signed playback ────────────────> R2 (private)
   └─ API (Bearer) ─> Cloudflare Worker "narriflow-api" (apps/api, Hono)
        ├─ Hyperdrive (cache OFF, direct TLS) ─> Neon Postgres (Launch, scale-to-zero)   ← sole domain authority
        ├─ Workflows: ImportPipeline · RenderRun · OperationDriver · Maintenance          ← when things run
        ├─ Durable Objects: ProjectProgress (hibernating WS) · RateLimiter · LocalFetchMailbox (dev only)
        ├─ Cron Triggers: hourly safety reconciliation, daily retention/cleanup
        ├─ Executor control API (signed): acquire · renew · process-start · commit · fail · progress
        └─ Modal dispatch bridge (Python web fn: spawn/status/cancel) ─> Modal Functions (apps/media)
              fetch_source (Python downloader) · pin_source · prepare_clip · render_group · probe/extract
              thumbnail · export_bundle · dub_mix · outbound_delivery (guarded URLs)
              → artifacts to attempt-unique R2 keys → executor-control commit → wake obligation
Providers: ElevenLabs Scribe v2 (webhook → API) · OpenAI GPT-5.4 mini (workflow steps) · yt-dlp (laptop in dev, proxy in prod)
Dev only: laptop fetch agent (outbound WebSocket to LocalFetchMailbox; no inbound port, no DB credential)
```

| Job | Service | Plan |
|---|---|---|
| Web | Vercel | Pro at launch |
| API, workflows, progress, rate limits, cron | Cloudflare Workers + Workflows + Durable Objects + Hyperdrive | Workers Paid ($5/month plus usage); upgraded during development after deployed CPU gates exceeded Free limits |
| Storage and playback | Cloudflare R2 (private, signed grants) | Pay-as-you-go |
| Database | Neon (existing `narriflow-dev`) | Launch (usage-based) |
| Media execution | Modal Functions | Starter, then Team when more than 100 containers |
| STT / selection | ElevenLabs Scribe v2 / OpenAI GPT-5.4 mini | Usage |
| YouTube | yt-dlp; residential HTTP sticky proxy at launch | Bought at launch |

## 3. Authority rules (non-negotiable)

1. **Postgres decides.** All domain transitions commit in TypeScript services: Processing Usage reservation and settlement (Workspace usage lock, then Project admission lock), attempt tokens, executor ownership, leases, Render Group membership and outcomes, publication uncertainty, and the dispatch outbox.
2. **Workflows only schedules.** It handles dispatch, durable waits, deadlines and delivery retries. Every step re-reads the ledger before acting. A persisted step result, a Workflow instance ID or a Modal call result is never permission to mutate. Delivery retries never grant another charged attempt.
3. **Executors are untrusted and idempotent.** Modal and the laptop hold no database credential. They call the signed executor-control API. A job must **atomically acquire an executor owner** (not just prove a token) before expensive work. Duplicate invocations get the recorded disposition and start nothing. Charged start is recorded only after the real process starts; startup rejection is uncharged.
4. **Cancellation revokes commit authority in Postgres first.** External cancellation is best effort. Artifacts use invocation- and attempt-unique keys, so a stale process can waste bounded compute but can never publish, overwrite or delete a referenced object.
5. **No transaction, socket, pool checkout or coordinator claim survives a Workflow sleep.** The parent never holds a lease through a wait. A child never settles the parent.

## 4. Key designs

### 4.1 Dispatch outbox (replaces polling)
- A new `ExecutionDispatch` table holds: kind, subject id, subject generation, deployment epoch, deterministic delivery key (unique), due time, delivery lease/token, attempts, next delivery, destination acknowledgement, and bounded error/dead-letter facts. It stores references only, never transcripts, secrets, signed URLs or media.
- `WorkflowEvent` remains the Project progress/history log. `WorkspaceEvent` remains the separate integration feed (ADR 0014).
- Protocol:
  1. The domain transition and its dispatch obligations commit atomically. Operation Receipts and Upload Session idempotency are preserved. The ingest→generation handoff obligation (`ingest-job-lifecycle.ts:359`) becomes a dispatch obligation.
  2. Deliver immediately after commit. The Workflow instance id is derived deterministically (epoch, kind, subject, generation, hashed to ≤100 chars). An already-existing instance counts as success. Acknowledge only after confirmed creation.
  3. Before returning "accepted", confirm scheduler registration. If it can't be confirmed, return a retryable response that carries the same receipt, so the client retry replays. `waitUntil` only accelerates delivery; it is never the guarantee.
  4. Child work registers its wake and deadline obligation before dispatch.
  5. Media completion, STT completion, settlement-due, event publication, Finishing and follow-up admission each commit their own wake obligation. A callback response means "result plus wake committed".
  6. An hourly bounded indexed safety scan redelivers abandoned gaps. Its worst-case recovery (about 1 h) is recorded as an availability failure, not as meeting a fast-recovery promise.

### 4.2 Leases, deadlines and expiry (replaces reapers)
- Distinguish a renewable **lease expiry** from an absolute **operation deadline**, a **provider-submission deadline** and a **retry `dueAt`**. Replace the Transcript `updatedAt` timeout anchor with explicit timestamps.
- Keep the existing ownership facts. `IngestJob.claimId/claimExpiresAt` fence completion and pinning (`ingest-job-lifecycle.ts:374,429`): keep them or replace them with equivalent named owner/lease fields. Keep Render Group execution history, charged counts, provider-wait identity and publication claims.
- The operation's Workflow is its watchdog. It waits for completion or the nearest deadline, with no SQL polling. A due handler carries epoch, generation, token and observed deadline. It locks, reads DB time, and then no-ops (terminal or superseded), sleeps to the new lease (renewed), or runs the domain expiry transition. Renewal does not create a timer per heartbeat; the watchdog wakes at its prior due time and re-reads.
- Heartbeats renew only running work. On loss, the executor kills its process group.
- Restore bumps the deployment epoch and invalidates all prior external execution authority.

### 4.3 Executor control API and Modal bridge
- Narrow, schema-validated commands: `acquire`, `renew`, `process-start`, `read-disposition`, `commit-artifact`, `fail/release`, `progress`. This is not a generic SQL or service tunnel. Routes have independent trust admission, strict methods, small body limits and route-inventory coverage.
- Signature: keyed and versioned over method, canonical path/query, body digest, timestamp, delivery id and audience. Keys are separate for Worker→Modal, Modal→Worker and the dev device, and rotate by key id. Verification is constant-time with a bounded clock window. A durable inbox receipt makes an exact replay return the recorded disposition; same id with different content is rejected. A valid signature still needs epoch, generation, token, owner, live lease, immutable input hash and an allowed action.
- Artifacts must match the operation's namespace, role, content type, size and frozen binding. The service HEADs storage before publication. Callback-supplied arbitrary keys, workflow ids or URLs are never accepted. Credentials, signed URLs, proxy credentials and caption text are never logged.
- **Modal bridge:** a small authenticated Python web function accepts a reference-only command, calls `.spawn()` on the heavy function, returns the call id promptly, and exposes status/cancel. A lost spawn acknowledgement is retried with the same dispatch identity. Modal may reschedule crashed containers even with `retries=0`, so executor acquisition is mandatory. A Modal result is never stronger evidence than the committed outcome.
- Executors get short-lived scoped R2 grants to attempt-unique (multipart) destinations.

### 4.4 API on Workers
- Replace `Bun.serve` and process signal handlers (`apps/api/src/index.ts:33,77`) and filesystem readiness (`runtime.ts:33`) with Workers `fetch`/`scheduled`/Workflow exports, a pinned compatibility date and `nodejs_compat`.
- Prisma 7 engine-free client with `@prisma/adapter-pg` and pinned `pg` newer than 8.16.3. The client is request/step-scoped from `env.HYPERDRIVE.connectionString`, injected into services and closed in `finally`. No global `PrismaNeon` singleton or process-env construction (`packages/db/src/client.ts:4,67`). Static liveness and DO-only traffic never open the DB.
- Hyperdrive points at Neon's **direct** TLS endpoint, with query caching explicitly **off**. Prove interactive transactions, advisory transaction locks, `FOR UPDATE`, raw SQL, cancellation and lock order through deployed Hyperdrive.
- Narrow Workers-safe service entrypoints. Route runtimes and remote MCP stop importing the full `@narriflow/services` barrel. Audit the real bundle (128 MB isolate limit, no multi-GB buffering).
- Native and Node replacements:
  - `review.service.ts:2` guest passcodes: Argon2 → WebCrypto PBKDF2-HMAC-SHA256 (16-byte salt, 600k iterations, 32-byte output), with bounded input and rate admission before hashing. Dev hashes reset; no legacy verifier.
  - `brand-font.service.ts`, `visual-asset.service.ts:230`, `thumbnail-frame-preparation-runtime.ts:423` (fonts, probe, Sharp) → bounded Modal validation jobs. An asset becomes usable only after validation commits.
  - `url-guard.ts:373,411` pinned-DNS transport stays as-is inside a lean Bun Modal function (`outbound_delivery`) for arbitrary callback, RSS and direct-media URLs. The Worker calls known provider origins only.
  - `rate-limit.ts`, `workflow.service.ts`, `pexels.service.ts`, `optional-redis.ts` (Redis) → RateLimiter DO (fail-closed for new mutations), a Cache API/R2 cache for Pexels, and DO progress delivery.
  - `r2-storage.ts:1`: split signing/HEAD/multipart control (Worker) from file transfer (Modal or direct clients).
- `apps/mcp` stdio currently imports services and authenticates against the DB (`apps/mcp/src/index.ts:5,11`). Convert it to an authenticated stdio bridge to remote `/mcp`, keeping tools, resources, Apps, Tasks and confirmation behavior.

### 4.5 Media code placement
Keep the hardened TypeScript renderer and run it in Bun inside Modal. Use Python only for the downloader, the detector programs and the Modal glue. There is one rendering implementation, and the caption cue model and composition plan never fork.

| Modules | Language → destination | Runs where |
|---|---|---|
| `packages/composition-plan`, caption preset/style logic, `packages/caption-fonts` | TS, unchanged packages | Browser preview and the Bun media compiler share them. Cues stay at `clip-composition-plan.ts:2372`. |
| `composition-ffmpeg-adapter.ts`, `caption-ass.ts`, `caption-glyphs.ts`, `ffmpeg-text.ts`, font resolution, output validation/mix/fact/key helpers | TS → `apps/media/src/**` | Bun in `render_group` |
| `clip-render-attempt*.ts`, `layout-evidence*.ts`, `layout-engine.ts`, `cut-plan.ts`, `reframe.ts`, `two-up.ts`, `screen-layout.ts`, preview/auto-layout | TS → `apps/media/src/**` | Bun in `prepare_clip`/`render_group`, with injected control/storage/process ports and no DB |
| `worker-process.ts` and native ops (probe, audio extract, language-probe audio, dub mix, export zip, thumbnails) | TS → `apps/media/src/**` | Bun, which owns scratch, process groups, TERM/KILL and deadlines. The Python wrapper forwards signals and reaps. |
| `scripts/reframe_detect.py`, `scripts/pip_detect.py`, pinned weights | Python → `apps/media/python/detectors/**` | Model-loaded image; emits versioned observations only |
| yt-dlp acquisition, PO-token helper, sticky proxy, fetch manifest | Python → `apps/media/python/narriflow_media/fetch.py` | Laptop (dev) and Modal (proxy), as one library. It calls the TS normalized-probe CLI rather than another ffprobe parser. |
| Modal app/images, bridge, wrapper | Python → `apps/media/modal_app.py` | Thin platform glue, no domain logic |
| `transcribe.ts` and `detect-clips.ts` control, all lifecycles, publication, billing, Finishing, cleanup | TS → `packages/services/src/**`, adapters in `apps/api/src/workflows/**` | Worker/Workflow steps with a scoped Prisma client |

Images:
- A **lean** fetch/control image and a **render/analysis** image, both from one locked toolchain.
- Pinned versions: FFmpeg 7.1.5, Bun, libass, fonts, model hashes, and **Python 3.13.5** (per `runtime-lock.json`; changing it needs parity evidence).
- Render: `cpu=4` physical cores / 8 GiB with a hard memory ceiling, one input per container, and matching FFmpeg/BLAS thread limits.
- Prepare/fetch: 2 cores / 4 GiB.
- Disk sized for source plus intermediate plus output. `min_containers=0`, short scale-down.

### 4.6 YouTube: local in development, proxy at launch
`YOUTUBE_FETCH_MODE=local|proxy` selects only *where* the same `FetchSourceCommand` runs. Manifests, verification, fencing, error codes and commit commands are identical.

- **Local (dev only):** `bun run fetch:local` starts the laptop agent.
  1. Short-lived dev-device session, scoped to one allowlisted dev Workspace. No Clerk secret, API key or DB credential.
  2. Outbound authenticated WebSocket to the `LocalFetchMailbox` DO. Keepalives and presence live in the DO. On connect, one authorized reconciliation of pending dispatches; no periodic SQL.
  3. An admitted link intake commits the normal fetch dispatch. The Workflow posts the id to the mailbox and waits durably.
  4. The agent calls `acquire` (random owner, 120 s lease, absolute 45 min fetch deadline) and renews about every 30 s only while working. A duplicate delivery gets the current disposition.
  5. The downloader normalizes and allowlists the media id, ignores the user's yt-dlp config, fetches **audio and full video concurrently**, and publishes audio as soon as it's verified so STT starts. Uploads go to assigned R2 destinations via scoped grants, followed by the same commit commands as Modal.
  6. If the laptop sleeps or disconnects, the lease expires and that owner is fenced. Retry needs domain permission.
  7. Agent offline at admission: show the existing "upload instead" path. Lost after admission: `waiting_for_local_fetch`, then a typed retryable failure. There is never a datacenter fallback.
- **Proxy (launch):** dispatches to Modal `fetch_source` with a validated HTTP (not SOCKS) `YTDLP_PROXY_URL` and its sticky-session template. One session per bound extraction and transfer. Retry a block with fresh extraction on a new session, at most 3 sessions. Never reuse a URL resolved on an old exit IP. yt-dlp, FFmpeg and the token helper must all use the proxy. Direct egress is disabled.
- Both modes: 1080p preference, 10 GiB cap, finite deadline, bounded fragment retries (`-N` tuned by measurement), safe argv, multipart upload, immutable binding.
- Production rejects `local`. With no proxy configured, link admission is disabled and upload stays available. Launch requires only config, the secret and a proxy acceptance check; a bounded canary runs afterwards.
- **Full original video is kept.** Selected-range downloading and `SourceRange` are **not** part of this cutover: the Editor Timeline and layout evidence depend on the original source (GLOSSARY, ADR 0004). Ranged *reads* of the R2 original during render stay (`clip-render-attempt.ts:1475`).

### 4.7 Audio-first STT admission (ADR 0012 amendment)
- Represent **audio-ready** separately from **video-ready**. Never set `ingestStatus=ready` early.
- Add a `SourceAudio` artifact bound to: Project, intake/source revision, normalized upstream media identity, selected audio track, R2 object identity, byte length/hash, exact probed duration of the **whole source**, and probe/toolchain version.
- The transaction that admits link STT locks Workspace usage, validates the audio binding, settles the reservation once from that duration (plan cap compared before whole-credit rounding; month, capacity, restriction and free same-Project retry rules unchanged), records the evidence, and admits STT plus dispatch. The language probe also runs only after admission. Uploads keep verified-byte pinning and a whole-source probe.
- Before accepting the full video, verify the same media id, revision, track, A/V offsets and duration (tolerance ≤ max(1 s, 2 frames)). The tolerance can never hide a different credit debit or exceed the plan cap. A mismatch fails with `source_audio_video_mismatch`: release an unsettled reservation, keep settled usage, and record an operator-refund-needed fact (current operator-only refund rule).
- Preserve the supplied-caption / no-STT / caption-only paths (`transcribe.ts:525`) and the audio-only RSS and Drive/Zoom/direct adapters (`ingest.ts:1135`).
- Scribe: intent is recorded before POST (`transcribe.ts:470`). Accepted request id stays distinct from transcription id. Callback and GET recovery share one finalizer. Unknown acceptance follows ADR 0018: a possible duplicate provider bill is accepted, a duplicate Processing Usage debit never is. Admission weights long files at `min(4, ceil(durationSeconds/480))` Scribe concurrency units.
- Selection runs the existing ~30-minute windows in parallel (2/4/6 for 1/2/3 h), persists each window result by reference, then does one global dedupe/rank/count and admits Clips plus the work set once. No payload over 1 MiB goes through Workflow state; use a reference-only envelope of about 64 KiB.

### 4.8 10 GiB sources and safe pinning
- Cap = `10 * 1024 ** 3` (`packages/validators/src/upload.ts:8`). A `transfer: "single"` request above R2's 5 GiB single-PUT limit returns a typed `multipart_required` (update `upload-session.service.ts:807`, REST docs `rest/routes.ts:341`, ADR 0005, the MCP/CLI clients). Browser `auto`, the 100 MiB threshold, server-owned part sizes and idempotent finalize are kept.
- Pinning: keep conditional `CopyObject` within its limit. Above it, R2 **does not support conditional `UploadPartCopy`**, so a Modal `pin_source` job does ranged `GetObject` with the verified `If-Match` into an attempt-unique multipart destination, with bounded buffers and concurrency. It aborts on any failed condition, persists source ETag, length and upload id for recovery, and HEADs the target before a fenced commit. The original grantable object is removed only after its grants expire.

### 4.9 Live progress over Durable Objects
- A ticket endpoint (ADR 0009 `content.view`) returns a one-use, 30 s connect ticket bound to actor, Workspace, Project, audience, Origin and nonce, with a 60 s maximum subscription lifetime. The Clerk Bearer token never goes in the socket URL. The Worker validates Origin; the DO consumes the nonce before upgrade.
- `ProjectProgress` DO: Hibernation API, attachment stores scope, expiry and cursor, one earliest-expiry alarm (no `setTimeout`), immediate revocation pushes from membership/restriction/deletion, and reconnect bounded to 60 s (replacing the 15 s SQL reauth).
- Delivery consumes committed events: subscribe, buffer, read the log up to a high-water mark, merge, dedupe by sequence, detect gaps, catch up, and reset to a snapshot past retention. The DO is a transport cache, not an authority.
- Client: keep `packages/api-client/src/progress/hub.ts` sharing and invalidation. Add `wss:` to the web CSP (`next.config.ts:103`). Remove the import screen's unconditional 5 s refetch when the stream is healthy (`import-progress.tsx:27`). The all-clips-ready rule is unchanged.

### 4.10 Publishing and integrations
- Scheduled posts: one wake per post id and schedule revision. An edit creates a new generation and fences the old one. At wake, re-read due time, cancellation, frozen export/editor/account, grant and attempt. An unknown response resumes or reconciles the same provider operation, never a blind new create (ADR 0007). Claims, checkpoints and receipts stay as TS service commands. Byte transfer runs in lean Bun Modal.
- Completion Callbacks and Webhook Subscriptions: terminal status and committed Workspace Events create dispatch obligations. One cursor per subscription; the cursor moves only after a 2xx. Delivery goes through the guarded `outbound_delivery`.

### 4.11 Every current worker loop gets a replacement

| Current loop (`apps/worker/src/index.ts`) | Replacement |
|---|---|
| ingest, generation handoff (`:469`, `:492`) | Intake outbox → ImportPipeline; audio-ready and video-ready wake it independently |
| workflow events (`:544`) | Destination-specific outbox obligations (DO progress, consumers) |
| STT submit/results (`:616`, `:624`) | Service submission; webhook and targeted recovery timers share one finalizer |
| detection, render, render_group (`:628`, `:706`, `:725`) | Bounded selection steps, frozen work set, per-group delivery, child deadlines, short parent settlement |
| upload session maintenance (`:520`) | Expiry/compensation due obligations; hourly backstop |
| dubbing, export bundle (`:636`, `:644`) | OperationDriver; native mix/zip in Modal |
| publish, receipt enrichment (`:654`) | Revision-bound wakes, same-attempt reconcile timers, callbacks |
| completion callbacks, webhooks (`:551`, `:560`) | Dispatch obligations plus guarded delivery |
| billing, pending business (`:569`, `:579`) | Stripe webhook → reconcile due; targeted retries; daily cleanup |
| performance capture/guidance (`:662`, `:680`) | Finite capture schedule per tracked post; nightly guidance refresh |
| autopilot, finishing (`:696`, `:700`) | Rule-revision next wake; Finishing due committed with generation settlement |
| preview, auto-layout (`:749`, `:756`) | Deduplicated `prepare_clip` jobs bound to clip window, revision and engine |
| notification retry (`:762`) | Existing intents/ledgers on OperationDriver; `packages/email` adapter untouched |
| media cleanup, render-object reconcile (`:788`, `:892`) | Exact-key obligations after commit; bounded daily/hourly safety work |
| generated media, thumbnails, library index (`:795`, `:803`, `:809`) | Due work on admission/Transcript completion; native parts in Modal |
| retention, purges, grants (`:489`) | Daily bounded maintenance plus known expiry wakes |
| executor health/scratch (`:882`, `:887`) | Per-container startup validation and per-job resource checks; no fleet loop |

## 5. Implementation tickets

All 24 ship together. "Blocked by" is a dependency, not a release phase. Shared schema, runtime wiring and manifests are integrated by one owner. Sources move once; later tickets edit the destination.

**Likely critical path:** 01 → 02 → 03 → 04 → 05 → 06 → 07/10/11/12 → 14 → 21 → 22 → 23 → 24.
- 09 starts after 01.
- 08 follows 05; 13 follows 03/05.
- 15–20 branch off and join at 22.

| # | Ticket | Blocked by |
|---|---|---|
| 01 | Freeze execution contracts and responsibility map | none |
| 02 | Single domain migration | 01 |
| 03 | Database scope and API runtime on Workers | 02 |
| 04 | Transactional dispatch and wake delivery | 03 |
| 05 | Lifecycle claimers/reapers → targeted commands | 04 |
| 06 | Executor control API and Modal bridge | 05 |
| 07 | 10 GiB multipart and safe pinning | 06, 09 |
| 08 | Link STT admission from verified Source Audio | 05 |
| 09 | Relocate TS media runtime to `apps/media`, pin images | 01 |
| 10 | Shared Python source downloader (local + proxy) | 06, 09 |
| 11 | Laptop fetch agent without SQL polling | 04, 05, 06, 10 |
| 12 | Scribe control as durable service steps | 03, 04, 05, 07, 08, 09 |
| 13 | Parallel selection with one global finalization | 03, 05 |
| 14 | ImportPipeline, RenderRun and OperationDriver | 04–13 |
| 15 | Authorized hibernating progress (replace SSE) | 03, 04 |
| 16 | Remaining native deps, Redis rate limits and cache | 03, 06, 09 |
| 17 | Publication scheduling and provider execution | 05, 06, 09 |
| 18 | Callbacks/integration events, MCP stdio bridge | 04, 05, 06, 09 |
| 19 | Other product jobs and billing maintenance | 04, 05, 06, 09, 17, 18 |
| 20 | Bounded maintenance, cleanup and restore tooling | 04, 05, 07, 19 |
| 21 | Linux media parity and crash correctness | 07, 09, 10, 14 |
| 22 | Integrated correctness, isolation, performance and idle gates | 14–21 |
| 23 | Remove obsolete code; dev/CI/docs | 22 |
| 24 | Execute the single cutover | 23 + owner prerequisites |

### 01. Freeze execution contracts and responsibility map
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
11. **Cutover authorization:** approve deployments, DNS/callback changes and the Railway/Upstash deletion only after reviewing the verified candidate. **Yes, at ticket 24.**
