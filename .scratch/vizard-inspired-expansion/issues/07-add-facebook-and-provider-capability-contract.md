# 07 — Add Facebook and a provider capability contract

**What to build:** Extend Meta account connection and Social Publisher with Facebook while centralizing platform limits and thumbnail support in one shared capability contract.

**Blocked by:** [Extend entitlements, permissions, and program analytics](02-extend-entitlements-permissions-and-program-analytics.md).

**Status:** done

**Specification:** [Publishing expansion and assisted copy](../features/publishing-expansion.md)

## Observable acceptance criteria

- [x] Shared platform schemas and Prisma support `facebook_reels` through an additive migration.
- [x] Meta OAuth lists eligible Pages, persists the selected Page account, and keeps Instagram connection behavior unchanged.
- [x] Facebook publishing follows existing Social Post status, retry, metric, and error contracts.
- [x] One capability table supplies aspect ratio, duration, text limits, thumbnail types, provider polling, and scheduling support to UI, validation, service, and worker.
- [x] Capability version is recorded with the Social Post validation result.
- [x] Provider errors map to stable codes without leaking tokens or response bodies.

## Tests and failure injection

- [x] Contract tests cover Page selection, wrong workspace, missing role, expired token, revoked permission, upload failure, processing timeout, rate limit, lost response, and duplicate publish.
- [x] Existing Instagram provider tests remain unchanged and pass.
- [x] Tests prove an unsupported thumbnail cannot pass direct API validation.

## Migration and rollout

- [x] Deploy the enum migration before code and enable account connection separately from publishing.
- [x] Keep the Facebook publisher dark until provider sandbox or test-Page evidence passes.

## Scope boundaries

- [x] Do not add other platforms or replace current Meta OAuth ownership.

## Fresh-task handoff

Implement with `/tdd`, use official Meta documentation during execution, finish with `/code-review`, and run provider, OAuth, migration, worker, typecheck, and repository tests.
