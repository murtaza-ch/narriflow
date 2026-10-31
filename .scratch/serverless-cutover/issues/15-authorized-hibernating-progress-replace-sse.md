# 15 - Authorized hibernating progress (replace SSE)

**What to build:** Authorized hibernating progress.

**Blocked by:** 03, 04

**Status:** claimed

**Spec:** [Serverless cutover](../spec.md)

- **Build:** §4.9.
- **Files:** `apps/api/src/domains/progress/**`, `apps/api/src/durable-objects/project-progress.ts`, `packages/api-client/src/{core,progress}/**`, `apps/web/app/_components/api-provider.tsx`, progress consumers, `apps/web/next.config.ts`.
- **Accept:** unauthorized access, cross-scope access, wrong Origin, ticket replay, revocation, restriction, deletion and expiry during hibernation are all covered. No lost events across the subscribe/replay race. Buffers bounded. No DB polling on a healthy stream.

## Evidence

Pending implementation and verification.
