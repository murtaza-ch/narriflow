# 06 - Executor control API and Modal bridge

**What to build:** Executor control API and Modal bridge.

**Blocked by:** 05

**Status:** ready-for-agent

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
