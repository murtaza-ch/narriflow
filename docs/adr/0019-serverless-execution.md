# Postgres owns execution; Workflows schedules it

**Status:** accepted design, 2026-10-31. Deployment requires the single integrated cutover in [the specification](../../.scratch/serverless-cutover/spec.md). Contract acceptance does not authorize an incomplete runtime cutover.

Narriflow replaces always-on API and worker processes with a Cloudflare Worker, durable Workflows and short-lived Modal media functions. Postgres remains the only authority for admission, credits, domain attempts, ownership, publication and settlement. The browser remains an API client. The laptop can execute development YouTube acquisition through an outbound connection; it has the same narrow executor authority as Modal and no database credential.

## Scheduling and domain authority

A domain transition inserts its Execution Dispatch obligations in the same transaction. A dispatch records destination kind, subject kind and ID, subject generation, deployment epoch, immutable input hash, deterministic delivery key, due and next-delivery times, delivery ownership, acknowledgement and bounded failure facts. It contains references only. Workflow Event remains Project progress/history; Workspace Event remains the integration feed. Neither event log is repurposed as a scheduler ledger.

Destination kinds are `import_pipeline`, `render_run`, `operation_driver`, `maintenance`, `project_progress`, `local_fetch` and `modal_execution`. The destination is separate from the domain subject and the command action. Worker entrypoints and Workflow steps resolve a fresh scoped Prisma client through uncached Hyperdrive, inject it, then close it in `finally`. No connection, transaction or claim crosses a durable sleep. Static health and Durable Object keepalives open no database connection.

After commit, delivery confirms registration using an instance ID derived from epoch, kind, subject and generation, hashed to at most 100 characters. Confirmed creation or confirmed existence acknowledges registration. Ambiguous delivery remains unacknowledged and replays the same key. Acceptance returns only after registration is confirmed; a retryable response retains the same Operation Receipt or Upload Session identity. `waitUntil` accelerates delivery but is not its guarantee. Before child dispatch, persist its parent wake and deadline obligations. Result, wake and event publication obligations commit together. An hourly bounded indexed scan repairs abandoned delivery gaps; an hour of recovery is an availability failure.

A Workflow orchestrates dispatch, waits and deadlines. Every step rereads the domain ledger. A completed step, external call result or Workflow instance is never mutation authority and never creates another charged attempt. Selection windows persist results by reference, with one global finalization; frozen Render Work Set membership still determines parent settlement. The parent has no lease while awaiting children; child commits never settle the parent.

## Fencing and lock order

An admission transaction first locks the singleton Execution Epoch `FOR SHARE`.
Closing `admissionOpen` waits for earlier admissions to finish. Exact authorized
durable replay returns while closed; fresh root work and new Finishing
suboperations fail with retryable `execution_admission_closed` before their work
is committed. Already-admitted pipeline transitions, completion, expiry and
receipt recovery remain allowed. There is no environment override or HTTP-wide
database gate. Synchronous provider features make the admission decision in a
short transaction before HTTP, without retaining a database lock during HTTP.

Workspace usage advisory lock follows the epoch and precedes Project admission lock. When required, domain rows follow in deterministic order: parent Workflow Run, Render Group, member, variant. Domain-specific locks retain their existing ordering. Event sequence counter locks remain last, as in ADR 0014. Observe database time after locks with `clock_timestamp() AT TIME ZONE 'UTC'`, never transaction-start or process time.

Every external mutation compares current deployment epoch, subject generation, immutable input hash, existing domain attempt token, executor owner, live lease and allowed action. Domain cancellation or supersession revokes this authority in Postgres before best-effort external cancellation. A restore increments the deployment epoch before redispatch, fencing all earlier executors and device sessions.

Execution Attempt stores executor ownership for an already admitted domain token; it is not a new domain attempt or retry budget. Atomically acquiring one owner is mandatory before expensive work. Two owners cannot both acquire the same token. A duplicate invocation gets the recorded disposition and starts nothing. The owner records process start only after successful real process startup and cannot proceed if recording start fails. Domain start accounting is idempotent. Acquisition and pre-start rejection are uncharged. Existing Ingest Claim and Render Group history, membership and charge ledgers remain authoritative and are not replaced by transport delivery counters.

A renewable lease, absolute operation deadline, provider-submission deadline, provider-result deadline and retry `dueAt` are distinct facts. A heartbeat renews only active work and cannot extend the absolute deadline. The Workflow watchdog wakes at its prior due time with epoch, generation, token and observed deadline, locks, reads DB time and either no-ops, sleeps to a renewed deadline or invokes the same domain expiry transition used by the hourly safety scan. Renewal does not schedule another timer. Ownership loss kills the executor process group.

An active TS execution budget is fixed within its generation (STT control uses ten minutes). Entering provider wait closes/revokes that generic TS execution and clears its domain lease; the domain attempt token remains provider lineage only. Scribe's explicit submission and two-hour result deadlines own this wait, without a generic native watchdog over it. An authorized queued/unowned provider retry advances the Workflow Run generation and may clear/rebind the next active TS execution deadline, while the charged attempt cap remains in force. Ingest and Render Group absolute operation deadlines remain fixed across their retries.

Scribe admission serializes the provider's measured duration weights, `min(4, ceil(SourceAudio.durationSeconds / 480))`, with a PostgreSQL advisory lock after ordinary run locks. The concurrency cap is required configuration (`SCRIBE_MAX_CONCURRENT_UNITS`), with no code default. Only current source-bound runs with live TS leases or live provider deadlines consume units. Capacity denial keeps an unowned, uncharged queued run and records the nearest known release deadline. Completion, failure, expiry and source cancellation append bounded waiter wakes. Each wake requires a fresh capacity count; it is never a permit. Full UUID cursors in persisted `stt_` and `cancel_` continuation wakes bound delivery pages without queue polling.

## Executor control and immutable artifacts

[The strict schemas](../../packages/validators/src/execution.ts) define `acquire`, `renew`, `process-start`, `read-disposition`, `commit-artifact`, `fail`, `release` and `progress`. The 64 KiB command and reference envelope limit is enforced before parsing by adapters. No transcript, caption text, credentials, signed URLs or media goes into Workflow state, dispatch rows or diagnostics. A reference is `{dispatchId, deploymentEpoch, kind, subject: {kind, id}, generation, inputHash}`. A fence adds the existing domain `attemptToken` and invocation `owner`.

Sign HMAC-SHA256 version 1 using 32 to 64 raw key bytes and a distinct key ring per direction: Worker to Modal, executor to Worker, and development device. The signed message is the UTF-8 encoding of these fields joined by a single LF, with no trailing LF: `version`, `keyId`, `audience`, uppercase method, canonical target, lowercase body SHA-256 hex, Unix-seconds timestamp, delivery UUID. Canonical target is pathname plus query, with query pairs sorted by decoded name then decoded value in UTF-8 byte order, preserving duplicate pairs and empty values, and encoded using RFC 3986 unreserved bytes only. Spaces encode as `%20`; percent escapes use uppercase hex. Paths must already use the RFC 3986 encoding of each decoded segment, with no dot segments, repeated slash, encoded unreserved aliases, backslash, control byte, double-encoded escape or percent-encoded slash. Verification compares exact request method and target, hashes the raw body, validates the expected audience and active key ID, and compares signatures in constant time. Reject timestamps beyond the 300-second absolute clock window before mutation. An exact durable inbox receipt replays the committed disposition; the same audience/delivery ID with another canonical request digest is a conflict. The inbox digest uses the LF-joined version, audience, method, canonical target, body digest and delivery UUID. It excludes key ID and timestamp so a freshly authenticated retry can recover a committed response after key rotation or the clock window. Verification always precedes receipt lookup. A replayed acquired or renewed disposition retains its original absolute lease expiry and cannot issue fresh upload grants. Executors compare that expiry against the fresh TLS response's `X-Execution-Server-Time` and a conservative request round-trip margin; after suspension or uncertainty they obtain new authority. Signature validity alone grants nothing.

The authenticated Python Modal bridge accepts a reference-only spawn/status/cancel command. A lost spawn acknowledgement can cause another container, so `.spawn()` and `retries=0` cannot replace executor acquisition. Artifact grants name server-assigned, invocation- and attempt-unique private destinations. A commit supplies an assigned artifact ID, role, measured content type, byte length, SHA-256, ETag and binding hash. The service resolves the assigned namespace and HEADs the object before publishing through all fences. It never accepts a callback-selected key, URL or Workflow ID. An ambiguous commit is resolved through `read-disposition`; the executor cannot infer that the object is unreferenced and delete it.

## Source Audio and media ownership

Source Audio is immutable whole-source audio evidence bound to Project, source revision, normalized upstream media identity, selected track, exact private object identity, byte length and hash, whole-source probed duration, probe version and toolchain fingerprint. Verified audio may admit Scribe before full video completes; it never marks `ingestStatus=ready`. Admission locks Workspace usage, validates the current binding, compares the exact duration with the plan cap before whole-credit rounding, settles usage once and admits STT plus dispatch together. The language probe runs only after this admission.

Full video must match media identity, source revision, selected audio track, offsets and duration within `max(1 second, 2 frames)`. That tolerance cannot change a credit debit or admit an over-cap source. Mismatch fails `source_audio_video_mismatch`; unsettled usage releases, settled usage stays and records operator-refund-needed evidence. Whole-source audio, audio-only inputs, supplied captions and no-STT paths keep the current product contract. No SourceRange model or range-only acquisition is introduced.

The TypeScript renderer, composition plan, caption cue derivation and normalized ffprobe parser remain single implementations. They move to `apps/media`; Python owns only downloading, detectors and Modal glue. Source identity and complete-window evidence bind preparation reuse. Native processes, file transfer and arbitrary guarded URLs run in lean or render Modal images. Worker code performs only storage signing/HEAD/multipart control and known-origin provider requests. R2's 10 GiB source cap uses multipart beyond single-PUT capacity. Large pinning uses conditional ranged GET into unique multipart output, aborts on any identity failure, and publishes only after target verification. Grantable originals remain held until grants expire.

Clip Preparation is deduplicated by Clip, immutable source/editor/engine binding and deployment epoch. Its input capsule binds the committed source-video artifact, full normalized probe, Editor Document and toolchain. Admission requires video-ready source evidence; a provisional upload key cannot authorize preparation. Source observations are prepared once, including typed unavailable outcomes, while the existing render-time policy gates Screen/Split application against actual downloaded B-roll. Preparation never guesses B-roll availability from credentials or selected URLs. Render Groups wait without ownership and consume committed preparation references. A stale export binding may serve its own frozen group but never overwrite a newer live Clip.

Server-side capsule writes have an exact-key cleanup obligation before PUT. Tentative writes use unique keys, so a later admission cannot revive a key already granted to a cleanup owner. Only one immutable input tuple is adopted by the deduplicated preparation row; losing writes remain known cleanup work. Referenced inputs retain their cleanup obligation for a future check, rather than completing the obligation while the reference exists. Cleanup scheduling and grant-aware deletion remain separate domain work.

Selection inputs and results also use unique nonce destinations. Their adoption
locks the planned exact-key cleanup row; a claimed or completed deletion target
cannot become a visible reference. Successful sibling results stay held by their
immutable row references. Object cleanup runs in TypeScript on the Worker through
fixed-origin R2 DeleteObject, with no database lock across HTTP. It needs no native
process, so there is no additional Modal function or executor signature action.
Only an actual deletion acknowledgement completes an obligation; a reference hold
reschedules a future check. This replaces the earlier lean-Modal cleanup destination.

## Progress and external delivery

ProjectProgress uses hibernating WebSockets with a one-use 30-second connect ticket and a 60-second maximum subscription. Scope, Origin, actor, audience, nonce, expiry and cursor are persisted in the socket attachment. The DO consumes the nonce before upgrade, uses one earliest-expiry alarm and receives immediate membership/restriction/deletion revocations. Subscribe-buffer-replay merges committed events through a high-water mark, deduplicates sequence numbers, catches gaps and resets beyond retention. A healthy stream and idle local-agent socket perform zero SQL polling.

Publication wakeups bind the exact post schedule revision. Waking rechecks frozen export, editor, account, grant, cancellation and same-attempt provider identity. Pending or unknown acceptance reconciles that operation; unrecoverable unknown becomes Needs attention. It never blindly creates another post. Completion Callback and Webhook Subscription dispatches use the guarded `outbound_delivery` function. Each subscription advances its own cursor only after 2xx. Terminal transitions, Finishing, quota effects and follow-up admission remain transaction-owned.

Dubbing records a paid provider intent before its one provider POST. An intent
without a sealed result has status `unknown`, shown as "Dubbing outcome needs
review". Its quota reservation stays counted. The same frozen tuple cannot
automatically create another paid request. A deliberately repeated known failed
request receives a new Clip Dub and reservation, preserving prior accounting and
attempt history. The accepted Workflow Run remains the only execution owner.

## Failure state diagrams

```mermaid
stateDiagram-v2
    [*] --> Admitted: domain plus dispatch commit
    Admitted --> RegistrationUnknown: create or acknowledgement lost
    RegistrationUnknown --> Registered: retry deterministic identity confirms existence
    Registered --> Waiting: persist child wake and deadline before dispatch
    Waiting --> Waiting: duplicate callback replays inbox receipt
    Waiting --> Settled: result plus wake commits, parent rereads ledger
    Waiting --> Expired: locked due handler observes expired authority
    Waiting --> Cancelled: revoke in Postgres before external cancel
    Waiting --> Superseded: restore increments epoch or source generation changes
```

```mermaid
stateDiagram-v2
    [*] --> Checkpointed: persist provider submission intent
    Checkpointed --> Accepted: correlated provider result
    Checkpointed --> AcceptanceUnknown: response lost
    AcceptanceUnknown --> ReconcileSameAttempt: targeted wake or verified webhook
    ReconcileSameAttempt --> Accepted: receipt confirmed
    ReconcileSameAttempt --> NeedsAttention: no safe proof
    ReconcileSameAttempt --> DefinitivelyRejected: provider proves no acceptance
    DefinitivelyRejected --> RetryDue: domain admits bounded linked retry
```

```mermaid
stateDiagram-v2
    [*] --> CheckDevice: development link admission
    CheckDevice --> UploadAvailable: allowlisted device offline
    CheckDevice --> WaitingForLocalFetch: device present, fetch dispatch committed
    WaitingForLocalFetch --> Acquired: exact-id owner acquisition
    Acquired --> AudioReady: verified audio commit plus wake
    AudioReady --> VideoReady: bound full-video commit plus wake
    Acquired --> RetryableFailure: lease or absolute deadline expires
    AudioReady --> RetryableFailure: laptop sleeps, stale owner fenced
    RetryableFailure --> WaitingForLocalFetch: domain admits retry
```

## Alternatives and source patterns

The [Cloudflare Workflows starter](https://github.com/cloudflare/workflows-starter) provides durable step scheduling; the [hibernation example](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/durable-objects/examples/websocket-hibernation-server.mdx) provides incoming-socket lifecycle and attachments. [Modal's examples](https://github.com/modal-labs/modal-examples/blob/main/07_web/discord_bot.py) show a small web function spawning longer work. [yt-dlp](https://github.com/yt-dlp/yt-dlp) provides shared extraction, config isolation and proxy support. These are platform examples, not Narriflow domain authority; the database fences and receipts above supply that authority.

We reject a generic SQL tunnel to executors, database polling inside Workflows, one timer per heartbeat, a parent lease spanning waits, platform retries as domain retries, signed URLs in durable messages, a second renderer, dual runtime cutover, legacy passcode readers and concurrent schedulers against one database. The [complete loop inventory and deletion map](../serverless-execution-inventory.md) assigns every old loop a trigger, retry and expiry owner. The deletion-inclusive candidate passes all real-platform and crash gates before the single routing switch; failed gates keep admission closed and old credentials fenced.

## Measured passcode implementation, 2026-10-31

The deployed Workers runtime rejected PBKDF2 at 600,000 iterations through both WebCrypto and node:crypto. The native limit is 100,000. Keep PBKDF2-HMAC-SHA256 at exactly 600,000 iterations, a random 16-byte salt and a 32-byte result; use the pinned @noble/hashes 2.4.0 implementation for derivation, WebCrypto for salt randomness and the runtime timing-safe comparison. This replaces the spec's choice of native WebCrypto derivation, with the same algorithm and security parameters. It is the only current passcode implementation, with no legacy verifier. The deployed implementation matched the independent Python hashlib vector. [Raw gate evidence](../../.scratch/serverless-cutover/evidence/platform-crypto-20261031.json) records the exact failure and successful replacement; its frozen Worker clock values are not latency measurements. Rate admission must succeed before any expensive derivation.


Internal watchdog commands use the same bounded inbox table under an internal-only `watchdog` audience. It is absent from the external signature schema. Domain expiry, generic attempt revocation and wake IDs commit together, so a lost scheduler acknowledgement can replay delivery. A non-mutating sleep observation is never persisted as a reusable permission or receipt; its next invocation reads the current lease and database clock again.

Multipart transport stores a compact immutable plan of up to640part tuples in the existing assigned artifact row. A native command grants at most16parts and identifies outputs by their assigned ID. Completion sends the full measured SHA256 and byte length; server-side ListParts supplies the provider receipts. Abort and completion have exclusive persisted intent. An uncertain completion checks HEAD and never aborts the same upload. A replay returns the original grant expiry, while a new delivery requires fresh lease and absolute-deadline authority. Provider I/O happens outside SQL transactions and publication still requires the domain artifact commit.

Object work packages bind a separate raw-byte SHA256 alongside their exact storage key, ETag and byte length. This digest is independent of the semantic execution inputHash. The tuple is bounded to16MiB and becomes immutable before acquisition; native loading verifies the raw bytes before JSON parsing. Generic attempt identity and its absolute deadline cannot be rewritten. Small validated command inputs remain inline.

Internal maintenance and restore pages use separate `maintenance-page` and
`restore-page` inbox audiences. The exact dispatch ID, epoch and frozen cursor
bind their request hash. Page mutations, the outcome and all wake IDs commit
in the same transaction; a lost acknowledgement replays those IDs rather than
consuming another page. These receipts retain seven days. After that window an
operator starts a fresh bounded pass or an explicit restore heal. Signed executor
audiences cannot write these internal receipts.
