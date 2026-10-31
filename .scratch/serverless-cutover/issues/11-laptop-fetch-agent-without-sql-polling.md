# 11 - Laptop fetch agent without SQL polling

**What to build:** Laptop fetch agent without SQL polling.

**Blocked by:** 04, 05, 06, 10

**Status:** claimed

**Spec:** [Serverless cutover](../spec.md)

- **Build:** §4.6 local mode: dev-device session, `LocalFetchMailbox` DO, outbound agent, reconnect reconciliation, exact-id claims, active-only renewal, scoped uploads, offline capability.
- **Files:** `apps/api/src/durable-objects/local-fetch-mailbox.ts`, dev-only execution routes/admission, `apps/media/python/narriflow_media/local_agent.py`, root `fetch:local` script, link capability UI.
- **Accept:** a deployed Workflow completes a YouTube fetch through the Mac's IP. No inbound port and no DB credential. An idle connection makes zero SQL queries. Duplicate delivery, sleep, crash, expiry, cancel, stale upload and wrong Workspace are all tested. Production can't route to a device.

## Evidence

Device session codec, hibernating Workspace mailbox, signed HTTP boundary, reconnect dispatcher, outbound laptop agent and development setup UI are implemented. Workerd mailbox5checks, HTTPwrong-audience/tamper/Workspace isolation, source availability refusals and native client protocol tests pass. Idle mailbox traffic has no PostgreSQL binding. Production and non-allowlisted Workspaces cannot route to a device.

The deployed Mac YouTube completion and integrated sleep/crash/stale-upload acceptance gates remain open; this ticket remains claimed.
