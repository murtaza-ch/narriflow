# 01 - Authentication and transport

**What to build:** Audience/scoped OAuth, fresh stdio credentials, exact-origin CORS, bounded requests, availability-aware limiter, safe diagnostics.

**Blocked by:** None.

**Status:** done

**Owner:** root

- [x] Authentication and serving tests cover invalid, revoked, expired, mismatched audience and throttled credentials.
- [x] Origin, body bound, SDK protocol parity, and read/write outage behavior verified.

Clerk development audience/PKCE/scopes configuration applied with explicit administrator authorization; live client consent remains a release gate in ticket 06.
