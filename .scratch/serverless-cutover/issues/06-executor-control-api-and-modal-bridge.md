# 06 - Executor control API and Modal bridge

**What to build:** Executor control API and Modal bridge.

**Blocked by:** 05

**Status:** claimed

**Spec:** [Serverless cutover](../spec.md)

- **Build:** §4.3: signed commands, replay receipts, trust admission, scoped grants, Python spawn/status/cancel, TS RPC adapters for lifecycle ports.
- **Files:** `packages/validators/src/execution*.ts`, `apps/api/src/domains/execution/{routes,admission,runtime}.ts`, `packages/services/src/executor-control*.ts`, `apps/media/python/narriflow_media/{bridge,control}.py`.
- **Accept:** a wrong key, audience, path, body or age, or a conflicting replay, fails before mutation. An exact replay returns the prior disposition. A stale token fails. Spawn-ack loss and Modal rescheduling never run a duplicate heavy job. Commit with a lost callback-ack keeps the object and the wake.

## Evidence

Signature-only preparation is implemented while ticket 05 remains a blocker. This ticket is not complete.

- Pure `@narriflow/services/execution-signature` sign/verify with injected bytes, clock and per-direction key ring, WebCrypto HMAC verification, 64 KiB body bound and identifier-only errors.
- Shared Python stdlib protocol in `apps/media/python/narriflow_media/signing.py`, with no platform, environment, database or clock dependency.
- Three frozen known-answer vectors independently calculated using manually specified canonical targets and CPython stdlib SHA-256/HMAC. Both implementations verify the same metadata and inbox request digest.
- Coverage includes wrong key/body/method/target/audience/version, unknown/retired keys and rotation, ±300-second clock edges, duplicate/empty query pairs, UTF-8 byte sorting, malformed UTF-8, noncanonical path aliases, key bounds and body bounds.

Verification, 2026-10-31:

- `bun test packages/services/src/execution-signature.test.ts`: 8 passed, 60 assertions.
- `uv run --python 3.13.5 --no-project python -m unittest discover -s apps/media/python/tests -p test_signing.py`: 4 passed.
- `bun run --cwd packages/services typecheck`: passed.
- Biome check of TypeScript protocol/tests, shared vectors and services manifest: passed.

Still required after ticket 05: durable replay inbox, domain-owner fencing, scoped grants, route trust/admission/inventory, actual Modal spawn/status/cancel bridge, rescheduling and acknowledgement-loss integration gates.

### Watchdog authority and replay

Root added `expireDeadline` to executor control. It locks epoch, domain, then attempt; checks the exact attempt reference; re-reads DB time and the current nearest lease/absolute deadline. Renewed work returns sleep without caching that observation. A mutating expiry and wake IDs commit with an internal `watchdog` inbox receipt. Lost postcommit scheduler acknowledgement replays those wake IDs without charging or expiring twice. The internal audience is not accepted by the external signature schema.

Verification: isolated PostgreSQL control suite now 6 passed, 30 assertions, including real lease renewal observation and lost expiry-wake acknowledgement. Full production adapters and Modal bridge are still open.

### Modal transport preparation

`modal-bridge.ts` signs reference-only spawn/status/cancel commands for one configured HTTPS Modal origin. The Python raw ASGI bridge checks exact method/path, a 64 KiB body and independent bridge-audience keys before durable intent/receipt lookup. A changed same-ID command is refused before spawn. One 30-second transport slot bounds simultaneous unknown-ack retries; the API's executor acquisition remains mandatory before native work. Status/cancel resolve the call from a recorded spawn receipt and compare its exact invocation binding.

Verification: TypeScript bridge 3 passed, 15 assertions; Python bridge 5 passed, including changed raw bytes before lookup, refreshed-auth receipt replay, concurrent duplicate spawn, lost spawn acknowledgement and cross-invocation cancel refusal. Modal 1.2.6 SDK adapter signatures were checked locally. Live endpoint/native handler wiring and platform durability gates remain open.

### Scoped transfer control preparation

The signed transfer route verifies the exact raw target before resolving any database or storage work. Work packages assign owner-specific artifact IDs and keys. Native commands accept those IDs, frozen source names, byte lengths and checksums only. Multipart initialization, per-part checksum plans, exclusive abort/completion intent and sealed facts persist under fresh domain/attempt authority. Provider calls happen outside SQL transactions. Exact grant replay retains the original expiry; a new command after lease expiry is refused. A lost CompleteMultipartUpload response is resolved by HEAD and never followed by abort.

Focused verification: 24 fast tests passed, 127 assertions. Isolated PostgreSQL transfer suite passed3tests/17assertions for stale grants, changed part checksums, completion uncertainty and abort fencing. API and services typechecks passed. These are service/HTTP preparation; mounting the production domain registry and actual native bridge remain open.

The real Worker R2 binding adapter validates assigned artifact metadata and preserves quoted ETag conditions. Bounded JSON reads verify the exact ETag, size and full SHA256 before typed domain preparation. A stream exceeding64KiB is cancelled before buffering. Three unit tests passed14assertions, and all three checks also passed in actual local workerd with its R2 binding. `bun run --cwd apps/api test:artifacts:workerd` reproduces the runtime gate. The native font/visual composition now shares one control/transfer implementation; global route and Modal handler wiring remains open.
