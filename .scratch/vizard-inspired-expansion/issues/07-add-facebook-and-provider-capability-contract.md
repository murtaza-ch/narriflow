# 07 — Add Facebook and a provider capability contract

**What to build:** Extend Meta account connection and Social Publisher with Facebook while centralizing platform limits and thumbnail support in one shared capability contract.

**Blocked by:** [Extend entitlements, permissions, and program analytics](02-extend-entitlements-permissions-and-program-analytics.md).

**Status:** ready-for-agent

**Specification:** [Publishing expansion and assisted copy](../features/publishing-expansion.md)

## Observable acceptance criteria

- [ ] Shared platform schemas and Prisma support `facebook_reels` through an additive migration.
- [ ] Meta OAuth lists eligible Pages, persists the selected Page account, and keeps Instagram connection behavior unchanged.
- [ ] Facebook publishing follows existing Social Post status, retry, metric, and error contracts.
- [ ] One capability table supplies aspect ratio, duration, text limits, thumbnail types, provider polling, and scheduling support to UI, validation, service, and worker.
- [ ] Capability version is recorded with the Social Post validation result.
- [ ] Provider errors map to stable codes without leaking tokens or response bodies.

## Tests and failure injection

- [ ] Contract tests cover Page selection, wrong workspace, missing role, expired token, revoked permission, upload failure, processing timeout, rate limit, lost response, and duplicate publish.
- [ ] Existing Instagram provider tests remain unchanged and pass.
- [ ] Tests prove an unsupported thumbnail cannot pass direct API validation.

## Migration and rollout

- [ ] Deploy the enum migration before code and enable account connection separately from publishing.
- [ ] Keep the Facebook publisher dark until provider sandbox or test-Page evidence passes.

## Scope boundaries

- [ ] Do not add other platforms or replace current Meta OAuth ownership.

## Fresh-task handoff

Implement with `/tdd`, use official Meta documentation during execution, finish with `/code-review`, and run provider, OAuth, migration, worker, typecheck, and repository tests.
