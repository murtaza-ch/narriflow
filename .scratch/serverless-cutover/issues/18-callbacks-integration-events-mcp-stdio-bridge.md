# 18 - Callbacks/integration events, MCP stdio bridge

**What to build:** Callbacks, integration events, MCP stdio bridge.

**Blocked by:** 04, 05, 06, 09

**Status:** claimed

**Spec:** [Serverless cutover](../spec.md)

- **Build:** §4.10 delivery through guarded `outbound_delivery`. `apps/mcp` becomes an authenticated stdio→remote `/mcp` bridge with no DB or Redis.
- **Accept:** a slow receiver blocks only its own subscription. Cursors move only after a 2xx. DNS-rebinding, redirect, timeout and body-limit tests pass. MCP tools, resources, Apps and Tasks are unchanged.

## Evidence

The authenticated stdio bridge is implemented. Its spawned-child tests use the
actual remote MCP server and poisoned local database/Redis settings. They cover
modern and legacy envelopes, Apps resources and CSP metadata, confirmation,
Tasks, per-call credential revocation, streamed cancellation, EOF cleanup and
sanitized upstream failures.

[Stdio bridge evidence](../evidence/mcp-stdio-20261031.json).
Guarded outbound callback delivery and its acceptance gates remain required.
This ticket remains claimed.

Frozen callback/webhook notifications now have their own fenced OutboundDelivery
identity, body tuple and native receipt. Worker-side streamed HMAC keeps signing
keys private, while native execution re-resolves and pins the endpoint. The old
shared native transport and polling processors are removed. Webhook tests return
202 plus a scoped status read; actual Next.js checks cover pending, confirmed,
unconfirmed and Workspace switching.

[Notification evidence](../evidence/outbound-notification-20261031.json).
The root Workflow/producer composition, deployed 16 MiB body resource gate and
final native callback acceptance gates remain required. This ticket remains claimed.
