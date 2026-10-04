# 02 - Domain retries and atomic intake

**What to build:** Atomic mutation identities, immutable fingerprints, accepted replay, link ingestion with committed generation context, export/RSS/recovery retry safety.

**Blocked by:** None.

**Status:** done

**Owner:** domain implementer

- [x] Mutation and replay identity are transactional; changed inputs conflict and concurrent duplicates replay.
- [x] Quota/revision/publication services remain authoritative and link settings commit with ingest.
- [x] Meaningful domain tests and disposable database gate cover retries.

Evidence: services typecheck and focused Biome checks pass. The receipt suite includes locale-independent Unicode fingerprints, lost commit responses, concurrent preparation failure, and accepted scheduling reads before confirmation. Eleven PostgreSQL domain tests pass (77 assertions) for concurrent duplicates, rollback/restart, atomic link intake, generation settings and overlap, RSS replay after feed loss, worker lease preservation, export revision replay/conflict, and exact export cancellation before assignment or during shared-run/worker-claim races. The final isolated MCP gate passes 22 domain/Task tests (123 assertions), applies all 99 migrations, and drops its schema. Shared development migrations were not applied by this ticket.
