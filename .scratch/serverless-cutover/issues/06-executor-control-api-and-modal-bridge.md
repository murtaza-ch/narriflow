# 06 - Executor control API and Modal bridge

**What to build:** Executor control API and Modal bridge.

**Blocked by:** 05

**Status:** ready-for-agent

**Spec:** [Serverless cutover](../spec.md)

- **Build:** §4.3: signed commands, replay receipts, trust admission, scoped grants, Python spawn/status/cancel, TS RPC adapters for lifecycle ports.
- **Files:** `packages/validators/src/execution*.ts`, `apps/api/src/domains/execution/{routes,admission,runtime}.ts`, `packages/services/src/executor-control*.ts`, `apps/media/python/narriflow_media/{bridge,control}.py`.
- **Accept:** a wrong key, audience, path, body or age, or a conflicting replay, fails before mutation. An exact replay returns the prior disposition. A stale token fails. Spawn-ack loss and Modal rescheduling never run a duplicate heavy job. Commit with a lost callback-ack keeps the object and the wake.

## Evidence

Pending implementation and verification.
