# 07 — Recover unadopted duplicate media through Media Cleanup

**What to build:** Make Clip duplication preserve a durable recovery path for every copied object. A successful copy must either be adopted by the committed duplicate Clip or remain eligible for Media Cleanup, including when database persistence fails after one or several provider copies succeed.

**Blocked by:** 01 — Generalize Editor Media Cleanup into Media Cleanup.

**Status:** ready-for-agent

**Specification:** [Close the remaining architecture findings](../spec.md)

- [ ] Every destination object that can be successfully copied is covered by durable cleanup intent before it can become an unrecoverable orphan.
- [ ] A committed duplicate Clip atomically adopts its successful render and preview copies and prevents Media Cleanup from deleting adopted objects.
- [ ] A failed duplicate persistence step leaves every successfully copied but unadopted object eligible for Media Cleanup.
- [ ] A provider-copy failure creates no false adopted media and does not sink duplication when the existing product contract permits that variant or preview to be omitted.
- [ ] Mixed outcomes across several render variants and a preview preserve each successful copy's exact adopted-or-cleanup state.
- [ ] A database outage after provider success cannot reduce recovery to an ignored best-effort deletion result.
- [ ] Duplicate retries and concurrent requests cannot make cleanup delete media referenced by a winning duplicate Clip.
- [ ] Cleanup admission and adoption are idempotent for the duplicate operation's stable identities.
- [ ] Existing duplicate response behavior, copied Clip Editor Document, variant metadata, and omission of dubs and social posts remain unchanged.
- [ ] Diagnostics report bounded copy, adoption, compensation, and cleanup outcomes without object keys, signed URLs, provider identifiers, or raw errors.
- [ ] Deterministic tests cover all-copy success, partial copy success, zero copy success, persistence failure after each successful copy, retry, and concurrent duplicate outcomes.
- [ ] Isolated PostgreSQL and storage-adapter tests prove that adopted objects are never claimed for cleanup and unadopted objects remain recoverable after process interruption.
- [ ] The old ignored-result duplicate rollback helper is removed after durable compensation coverage lands.
- [ ] Focused Clip Service, Media Cleanup, database, typecheck, lint, and fast aggregate tests pass.

