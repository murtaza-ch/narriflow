# Establish Campaign Operation and export-bundle lifecycles

**What to build:** Add the idempotent selection-operation record, per-item outcomes, and bounded export-bundle worker path before adding new bulk UI.

**Blocked by:** [Extend entitlements, permissions, and program analytics](extend-entitlements-permissions-and-program-analytics.md).

**Status:** ready-for-agent

**Specifications:** [Program map](../spec.md), [Campaign bulk operations](../features/campaign-bulk-operations.md)

## Observable acceptance criteria

- [ ] Campaign Operation and item models store action, actor, project, idempotency, expected revision, per-item outcome, counts, and retry relation.
- [ ] The current Render selected service path records an operation without changing visible behavior.
- [ ] `export_bundle` freezes ready Clip Export Variant IDs and filenames before worker execution.
- [ ] The worker streams a bounded ZIP to an attempt-scoped object and publishes it only after completion.
- [ ] The manifest lists included and excluded items with stable codes and no signed URLs.
- [ ] Retry creates a linked operation containing only retryable items and never repeats successful work.

## Tests and failure injection

- [ ] Database tests cover duplicate submission, changed editor revision, missing clip, partial eligibility, concurrent retry, and item-count settlement.
- [ ] Worker tests inject failure during download, archive write, upload, publication, settlement, and ownership loss.
- [ ] Real archive tests verify sanitized collision-safe paths, contents, media checksums, and bounded memory.
- [ ] Expiry removes only the bundle object, not Clip Exports.

## Migration and rollout

- [ ] Add tables and read-only history before routing Render selected through them.
- [ ] Enable export bundles after operation counts and Render selected parity remain stable.

## Scope boundaries

- [ ] Do not add style, review, or scheduling actions in this ticket.
- [ ] Do not make Campaign Operation a Workflow Attempt or worker lease.

## Fresh-task handoff

Implement with `/tdd`, finish with `/code-review`, and run database, workflow lifecycle, storage, real ZIP, typecheck, and repository tests.

