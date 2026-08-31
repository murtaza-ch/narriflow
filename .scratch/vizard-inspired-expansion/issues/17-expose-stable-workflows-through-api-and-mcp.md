# 17 — Expose stable workflows through versioned API and MCP operations

**What to build:** Add public Business automation only after the corresponding web lifecycles are stable, without changing existing API keys, scopes, endpoints, or MCP tools.

**Blocked by:** [Build selection-scoped campaign actions](11-build-selection-scoped-campaign-actions.md), [Deliver the Review tab, guest room, and notifications](13-deliver-review-room-and-notifications.md), [Add assisted copy, thumbnails, and bulk scheduling](15-add-assisted-copy-thumbnails-and-bulk-scheduling.md), [Add suggestion-first Auto Censor](10-add-suggestion-first-auto-censor.md), and [Expand transitions and media motion](12-expand-transitions-and-media-motion.md). Short-video automation remains fail-closed until [Generate and insert short video](16-generate-and-insert-short-video.md) passes its separate provider entry gate; it does not block the stable image-job and status contracts shipped here.

**Status:** implementation-complete — staged rollout evidence pending

**Specification:** [Program map](../spec.md)

## Observable acceptance criteria

- [x] Add explicit API key scopes for brand read or write, campaign operations, review read or write, publishing preparation, and generated-media submission.
- [x] Existing scopes and tools retain their behavior.
- [x] Versioned REST operations call the same services and validators as the web app.
- [x] MCP tools expose high-level operations and typed status reads, not raw editor-document patches or signed URLs.
- [x] Mutations require caller idempotency keys and return durable operation or job IDs.
- [x] Review guest tokens and passcodes never appear in list responses, MCP logs, or analytics.
- [x] Automation cannot bypass plan entitlement, workspace role, approval gate, usage reservation, or rollout control.

## Tests and failure injection

- [x] Contract tests compare web, REST, and MCP outcomes for the same service fixtures.
- [x] Scope tests cover least privilege, revoked keys, workspace mismatch, downgrade, and restricted status.
- [x] Retry tests prove idempotency across timeout and lost responses.
- [x] Existing API and MCP compatibility fixtures remain unchanged and pass.

## Rollout

- [ ] Enable read operations first, then one mutation family at a time after web error rates and lifecycle reconciliation meet release gates.

**Remaining evidence:** Execute that read-first rollout in a deployed Business
cohort and exercise both REST and MCP with real least-privilege credentials.
Contract, revocation, downgrade, and parity tests do not substitute for those
live clients.

## Scope boundaries

- [x] Do not expose low-level provider controls, raw database IDs without ownership checks, or arbitrary document mutation.

## Fresh-task handoff

Implement with `/tdd`, finish with `/code-review`, and run API, MCP, scope, idempotency, compatibility, typecheck, and repository tests.
