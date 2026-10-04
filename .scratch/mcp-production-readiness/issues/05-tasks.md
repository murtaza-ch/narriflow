# 05 - Durable Tasks

**What to build:** Owned durable operation registry and negotiated modern task dispatcher with immutable outcomes and cooperative cancel.

**Blocked by:** [02 - Domain retries](02-domain-retries.md), [03 - Tool workflow](03-tool-workflow.md).

**Status:** done

**Owner:** root

- [x] Modern wire schemas, capability gate, reconnects, ownership, retention and cancellation races pass.
- [x] Unsupported clients receive ordinary durable operation results.

Evidence: modern wire tests validate flat handles separately from eventual results, routing headers, ownership, negotiated capability, private eventual-result caching and expired retention replay. The final MCP PostgreSQL gate passes 22 cases / 123 assertions across 99 migrations. Generation history follows immutable owned child outcomes; cancellation preserves later Studio cache resets, shared runs and claimed exports. Existing workers execute work. Live extension delivery remains deferred in ticket 06.
