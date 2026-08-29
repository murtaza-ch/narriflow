# 06 — Retire replaced detected-clip media through Media Cleanup

**What to build:** Make clip regeneration durably retire media owned by detected Clips that are replaced. The database mutation that removes the last render references must create Media Cleanup obligations in the same commit, so a storage outage cannot turn regeneration into invisible orphaned media.

**Blocked by:** 01 — Generalize Editor Media Cleanup into Media Cleanup.

**Status:** ready-for-agent

**Specification:** [Close the remaining architecture findings](../spec.md)

- [ ] Detected-clip replacement captures every non-null render object key whose last ordinary database reference will be removed.
- [ ] The same transaction that replaces or deletes the old detected Clips creates deduplicated Media Cleanup obligations for those objects.
- [ ] A failure before or during the transaction leaves the old Clips, render references, and cleanup state unchanged.
- [ ] A committed replacement leaves either an ordinary media reference or a durable cleanup obligation for every old render object.
- [ ] Both currently supported Workflow Run lifecycle paths preserve the same atomic replacement and cleanup guarantee without changing Workflow Run ownership or protocol-version policy.
- [ ] Storage deletion happens only through the Media Cleanup worker after the database commit; a temporary storage failure does not reverse or fail an already committed clip-detection outcome.
- [ ] Missing objects settle idempotently, and temporary failures retain retryable obligations until completion.
- [ ] Replaying the same detected-clip persistence cannot create competing cleanup work or delete media adopted by the current result.
- [ ] Diagnostics identify the replacement origin, project, Clip, class, attempt, and outcome without exposing object keys or generated document content.
- [ ] Deterministic module tests cover empty results, no old renders, duplicate keys, mixed null and real keys, replay, and obligation admission failure.
- [ ] Isolated PostgreSQL tests prove all-or-nothing replacement, cleanup-obligation insertion, concurrent settlement behavior, and survival after old Clip rows disappear.
- [ ] The old post-commit best-effort render deletion call is removed after the durable path has equivalent coverage.
- [ ] Focused lifecycle, Clip Service, Media Cleanup, database, typecheck, lint, and fast aggregate tests pass.

