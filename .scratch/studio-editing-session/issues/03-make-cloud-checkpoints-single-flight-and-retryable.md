# 03 — Make cloud checkpoints single-flight and retryable

**What to build:** Make the current Studio document converge to cloud storage through one serialized checkpoint protocol that remains safe through rapid edits, offline work, retries, export preparation, reset, and page close.

**Blocked by:** 02 — Recover Device Drafts and hand off one Studio Writer safely.

**Status:** completed

- [x] At most one cloud save is active, and edits during it produce exactly one latest-document follow-up.
- [x] A cloud acknowledgement advances only the exact document version it carried; newer edits remain dirty.
- [x] An idempotent retry of an already-committed document is treated as current rather than conflicting.
- [x] Network, offline, 408, 425, 429, and 5xx outcomes retry with jittered capped backoff; reconnect and explicit Save wake immediately.
- [x] Authentication loss, missing clips, semantic rejection, and revision conflict produce distinct typed states.
- [x] A semantically rejected document remains device-durable and editable, and a different corrected version may checkpoint.
- [x] Manual Save and prepare-cloud-revision settle only when the exact current document is cloud-durable.
- [x] Export creation receives the prepared revision but remains outside the Studio Editing Session.
- [x] Reset drains checkpoints, rejects new edits during its barrier, and returns a reload-required success.
- [x] Close is idempotent, releases resources, and never races a keepalive save against a regular save.
- [x] The existing revision-conflict behavior remains available through a temporary compatibility adapter until ticket 04.
- [x] Interface tests use an in-memory cloud adapter and manual clock for rapid edits, lost responses, retry, offline, rejection correction, export preparation, reset, and close.
- [x] Existing HTTP contracts and Postgres schema remain unchanged.
- [x] Exactly one module owns save, retry, reset, and close sequencing after cutover.
- [x] Repository typecheck and tests pass.
