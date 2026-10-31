# 11 - Laptop fetch agent without SQL polling

**What to build:** Laptop fetch agent without SQL polling.

**Blocked by:** 04, 05, 06, 10

**Status:** ready-for-agent

**Spec:** [Serverless cutover](../spec.md)

- **Build:** §4.6 local mode: dev-device session, `LocalFetchMailbox` DO, outbound agent, reconnect reconciliation, exact-id claims, active-only renewal, scoped uploads, offline capability.
- **Files:** `apps/api/src/durable-objects/local-fetch-mailbox.ts`, dev-only execution routes/admission, `apps/media/python/narriflow_media/local_agent.py`, root `fetch:local` script, link capability UI.
- **Accept:** a deployed Workflow completes a YouTube fetch through the Mac's IP. No inbound port and no DB credential. An idle connection makes zero SQL queries. Duplicate delivery, sleep, crash, expiry, cancel, stale upload and wrong Workspace are all tested. Production can't route to a device.

## Evidence

Pending implementation and verification.
