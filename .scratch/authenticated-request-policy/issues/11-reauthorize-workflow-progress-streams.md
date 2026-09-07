# 11 — Reauthorize workflow progress streams

**What to build:** Admit workflow progress streams through the same active-Project policy as ordinary requests and re-evaluate that policy during the connection. Session revocation, membership removal, role or Workspace-status change, Project access loss, expiry, or purge must close the stream with one safe control outcome and stop stale reconnect loops without disturbing durable event replay or Redis fallback.

**Blocked by:** 03 — Recover Workspace and Project admission.

**Status:** done

- [x] Initial stream admission uses the same actor, Workspace capability, Project scope, lifecycle, and failure contract as the matching Project page.
- [x] Long-lived reauthorization bypasses ordinary request-local caches and runs on the existing bounded heartbeat interval.
- [x] Reauthorization covers provider session, current App User, Workspace membership, role capability, Workspace status, Project scope, expiry, and purge state.
- [x] When access ends, the server emits at most one bounded safe control event when the connection permits it, then releases timers, polling, and Redis resources and closes.
- [x] The control event does not reveal private Workspace, Project, session, or denial details.
- [x] The browser distinguishes sign-in recovery, permission or restriction, Workspace mismatch, and unavailable Project, and does not reconnect indefinitely with stale credentials.
- [x] Durable event replay, sequence ordering, gap recovery, optional Redis subscription, polling fallback, abort cleanup, and successful heartbeat behavior remain unchanged.
- [x] Tests cover initial refusal and mid-stream loss of session, membership, capability, Workspace access, Project access, expiry, and purge, including cleanup races.
- [x] Direct stream actor and Project checks are removed after the policy path is proven.
