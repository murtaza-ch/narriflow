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

Notification producers now append callback creation/reset, subscription creation/enable,
and Workspace Event obligations in their owning transactions. A Workspace transaction
records one frozen sequence range, then bounded dispatchers create at most one hundred
event wakes, or one hundred callback wakes plus ten subscription wakes and a cursor.
No waiting-operation timer or SQL poller is added. Target preparation validates the
current epoch, exact ledger tuple and immutable callback/subscription hash. Native
terminal and watchdog receipts include the notification drain alongside domain and
progress wakes. Cancellation pages reserve the additional receipt slot.

The producer tests failed first on absent registration, absent bounded fan-out, lost
receipt-wake recovery, and absent enable wakes. Real PostgreSQL now covers those paths,
rollback isolation, changed target input, exact reset replay and terminal native receipt
replay after a lost scheduler acknowledgement. All 134 migrations plus the complete
execution gate pass 139 tests/909 assertions. Services, API and worker typechecks and
focused Biome checks pass. The invocation wrapper must run inside the database scope
before API responses or Workflow directives are returned. Production composition and
the remaining deployed native acceptance gates are still owned by integration, so this
ticket remains claimed.

Outbound preparation also accepts its expected immutable dispatch reference. It
checks the reference before reading trusted operation status and checks it again
under the existing epoch, Workspace and target locks before creating delivery
intent. A callback input changed between those checks produces a terminal result
without a frozen payload, body write or delivery row. The subscription and callback
race regressions failed first, then passed with the authoritative recheck.
