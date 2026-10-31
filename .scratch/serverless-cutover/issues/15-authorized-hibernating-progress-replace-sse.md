# 15 - Authorized hibernating progress (replace SSE)

**What to build:** Authorized hibernating progress.

**Blocked by:** 03, 04

**Status:** claimed

**Spec:** [Serverless cutover](../spec.md)

- **Build:** §4.9.
- **Files:** `apps/api/src/domains/progress/**`, `apps/api/src/durable-objects/project-progress.ts`, `packages/api-client/src/{core,progress}/**`, `apps/web/app/_components/api-provider.tsx`, progress consumers, `apps/web/next.config.ts`.
- **Accept:** unauthorized access, cross-scope access, wrong Origin, ticket replay, revocation, restriction, deletion and expiry during hibernation are all covered. No lost events across the subscribe/replay race. Buffers bounded. No DB polling on a healthy stream.

## Evidence

Implemented candidate ticket/socket transport, hibernating DO, bounded replay/cache and client replacement. Progress event delivery and membership/restriction/Project-deletion revocations append destination obligations in their owning transactions.

- [Local workerd transport gates](../evidence/progress-workerd-20261031.json):10checks.
- [PostgreSQL durability gates](../evidence/progress-durable-pg-20261031.json):7checks.
- [Next.js/Chrome import polling behavior](../evidence/progress-ui-20261031.json).

Production scheduler target/continuation registration now has [actual local Workflows + PostgreSQL + second-page socket proof](../evidence/workflows-workerd-20261031.json), including uncertain acknowledgement recovery. Still required: deployed hibernation/close confirmation and candidate end-to-end smoke. This ticket remains claimed.
