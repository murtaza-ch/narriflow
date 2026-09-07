# 12 — Cut over and prove Authenticated Request Policy

**What to build:** Complete the direct cutover so every browser-session Hono route, Server Action, server-rendered admission, and workflow stream has one Authenticated Request Policy owner. Remove the old request helpers, generic method-based Project middleware, handwritten common failures, message-based behavior, and redundant tests. Prove the complete contract through an explicit surface inventory, full verification, documentation, and authenticated browser checks.

**Blocked by:** 04 — Move Upload Session and ingest flows through policy; 05 — Move Project library and Clip editing through policy; 06 — Move generation, rendering, exports, and dubbing through policy; 07 — Move Content Suite and analytics through policy; 08 — Move social publication and connection flows through policy; 09 — Move Workspace administration and billing through policy; 10 — Move Brand, audio, and Autopilot flows through policy; 11 — Reauthorize workflow progress streams.

**Status:** done

- [x] An explicit inventory covers every browser-session Hono route, Server Action, server-rendered admission, and long-lived stream.
- [x] Public health checks, webhooks, OAuth callbacks that establish identity, MCP OAuth, scoped API keys, and public sharing are allowlisted with their separate trust model.
- [x] No inventoried browser-session surface resolves the current user, enforces common capability or Project policy, or emits common authorization and validation responses outside the approved module and adapters.
- [x] The ambiguous compatibility user shape, old request helpers, generic method-based Project middleware, and request-level owner-ID alias are deleted.
- [x] Handwritten `Unauthorized`, `Forbidden`, `Project not found`, and `Invalid payload` responses are absent from migrated browser-session surfaces.
- [x] Expected request behavior no longer compares exception messages or returns raw exception text. Unknown failures have safe structured diagnostics and a client-visible request identifier.
- [x] Successful statuses, payloads, redirects, revalidation, streaming, and completed domain-module behavior remain unchanged across every migrated family.
- [x] Shallow tests that duplicate policy decisions are removed only after equivalent interface coverage exists. Adapter tests remain focused on transport behavior.
- [x] The architecture review and permanent project documentation record the completed module, its evidence, operational diagnostics, and independent non-session trust models.
- [x] Focused policy, adapter, browser, stream, and disposable PostgreSQL suites pass.
- [x] Repository typecheck, tests, lint, and affected production build pass without relying on cached success.
- [x] Authenticated browser checks cover sign-in recovery, stale Workspace selection, role denial, restricted billing recovery, cross-Workspace Project switching, missing Project navigation, validation focus, conflict preservation, rate-limit wait, temporary retry, and mid-stream access loss.
