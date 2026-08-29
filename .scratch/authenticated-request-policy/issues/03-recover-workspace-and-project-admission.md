# 03 — Recover Workspace and Project admission

**What to build:** Make active Workspace and Project admission reliable for navigation and ordinary requests. Users with a stale Workspace selection should land in an available Workspace with a clear explanation. Authorized cross-Workspace Project links should offer an explicit switch and retry, while inaccessible, expired, and purging Projects remain concealed. Role and billing restrictions should produce recovery that matches the actor's ability to fix the problem.

**Blocked by:** 02 — Establish the Authenticated Request Policy tracer.

**Status:** ready-for-agent

- [ ] The active-Workspace cookie is treated only as a selection hint and never as membership proof.
- [ ] A stale or removed Workspace selection falls back only to a Workspace the actor can currently access, and the app shell presents a bounded Workspace-changed notice.
- [ ] Every Workspace role and active, pending-payment, and restricted status combination follows the existing capability matrix.
- [ ] Owners who can repair a billing restriction receive a billing recovery action. Other members receive guidance to contact an owner.
- [ ] Active Project admission performs one Workspace-scoped lifecycle lookup and treats absent, expired, and purging Projects consistently.
- [ ] A Project in another Workspace is disclosed as a Workspace mismatch only when the actor has a current membership there. The response contains no facts beyond the Workspace identity the actor may already see.
- [ ] A Workspace mismatch never switches context or retries a mutation automatically. The user confirms the switch first.
- [ ] Projects outside every Workspace the actor can access are returned as missing, without confirming their existence.
- [ ] Server-rendered pages, Hono responses, and browser recovery distinguish sign-in, permission, restriction, Workspace mismatch, and missing Project without leaking implementation messages.
- [ ] Exact capability declarations replace method-based read or write inference in the migrated navigation slice.
- [ ] PostgreSQL tests cover stale membership, role change, Workspace status change, cross-Workspace membership, Project expiry, purge start, and access removal between requests.
