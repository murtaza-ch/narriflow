# 18 - Callbacks/integration events, MCP stdio bridge

**What to build:** Callbacks, integration events, MCP stdio bridge.

**Blocked by:** 04, 05, 06, 09

**Status:** ready-for-agent

**Spec:** [Serverless cutover](../spec.md)

- **Build:** §4.10 delivery through guarded `outbound_delivery`. `apps/mcp` becomes an authenticated stdio→remote `/mcp` bridge with no DB or Redis.
- **Accept:** a slow receiver blocks only its own subscription. Cursors move only after a 2xx. DNS-rebinding, redirect, timeout and body-limit tests pass. MCP tools, resources, Apps and Tasks are unchanged.

## Evidence

Pending implementation and verification.
