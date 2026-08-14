# 03 — Make cloud checkpoints single-flight and retryable

**What to build:** Make the current Studio document converge to cloud storage through one serialized checkpoint protocol that remains safe through rapid edits, offline work, retries, export preparation, reset, and page close.

**Blocked by:** 02 — Recover Device Drafts and hand off one Studio Writer safely.

**Status:** ready-for-agent

- [ ] At most one cloud save is active, and edits during it produce exactly one latest-document follow-up.
- [ ] A cloud acknowledgement advances only the exact document version it carried; newer edits remain dirty.
- [ ] An idempotent retry of an already-committed document is treated as current rather than conflicting.
- [ ] Network, offline, 408, 425, 429, and 5xx outcomes retry with jittered capped backoff; reconnect and explicit Save wake immediately.
- [ ] Authentication loss, missing clips, semantic rejection, and revision conflict produce distinct typed states.
- [ ] A semantically rejected document remains device-durable and editable, and a different corrected version may checkpoint.
- [ ] Manual Save and prepare-cloud-revision settle only when the exact current document is cloud-durable.
- [ ] Export creation receives the prepared revision but remains outside the Studio Editing Session.
- [ ] Reset drains checkpoints, rejects new edits during its barrier, and returns a reload-required success.
- [ ] Close is idempotent, releases resources, and never races a keepalive save against a regular save.
- [ ] The existing revision-conflict behavior remains available through a temporary compatibility adapter until ticket 04.
- [ ] Interface tests use an in-memory cloud adapter and manual clock for rapid edits, lost responses, retry, offline, rejection correction, export preparation, reset, and close.
- [ ] Existing HTTP contracts and Postgres schema remain unchanged.
- [ ] Exactly one module owns save, retry, reset, and close sequencing after cutover.
- [ ] Repository typecheck and tests pass.
