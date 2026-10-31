# 01 - Freeze execution contracts and responsibility map

**What to build:** Freeze execution contracts and responsibility map.

**Blocked by:** none

**Status:** done

**Spec:** [Serverless cutover](../spec.md)

- **Build:** command/result schemas; lock order; epoch/generation/owner/lease/deadline semantics; dispatch inventory (§4.11); source/audio binding; deletion map. New ADR 0019 "Serverless execution". Amend 0001, 0003, 0004 (evidence transport), 0005, 0007, 0010, 0011, 0012, 0014 (delivery driver), 0017, 0018. Glossary terms.
- **Files:** `docs/adr/**`, `GLOSSARY.md`, `packages/validators/src/execution*.ts`.
- **Accept:** every loop has a trigger and destination. State diagrams cover ambiguous provider acceptance, response loss, cancel, restore and no-agent. Reuse patterns from cloudflare/workflows-starter, the DO hibernation example, modal-labs/modal-examples and yt-dlp, adding Narriflow's fences.

## Evidence

- [x] Strict reference, owner-fence, command/result, signed metadata, observed-deadline, artifact and Source Audio schemas exported from `@narriflow/validators/execution`.
- [x] [ADR 0019](../../../docs/adr/0019-serverless-execution.md) records authority, lock order, replay, restore, cancellation, ambiguous provider acceptance and no-agent state diagrams.
- [x] [Responsibility/deletion inventory](../../../docs/serverless-execution-inventory.md) covers all 31 `createPollLoop` names exactly. A source/inventory set comparison found no missing or extra loop.
- [x] Root glossary adds resolved Execution Dispatch, Execution Attempt, Deployment Epoch and Source Audio terms. ADRs 0001, 0003, 0004, 0005, 0007, 0010, 0011, 0012, 0014, 0017 and 0018 have explicit 2026-10-31 amendments.
- [x] Primary GitHub examples compared for Workflow scheduling, hibernating DO transport, small Modal spawn endpoints and shared yt-dlp acquisition. Narriflow's fences remain service-owned rather than copied from platform examples.

Verification, 2026-10-31:

- `bun test packages/validators/src/execution.test.ts`: 5 passed, 22 assertions. Each schema slice first failed for its missing exported contract, then passed through the public parser boundary.
- `bun run --cwd packages/validators test`: 685 passed, 0 failed, 3370 assertions.
- `bun run --cwd packages/validators typecheck`: passed.
- `bunx biome check packages/validators/src/execution.ts packages/validators/src/execution.test.ts packages/validators/src/index.ts packages/validators/package.json`: passed.

This closes contract design only. Signed verification, durable inbox and DB fencing implementation belong to later tickets. No runtime deployment or shared-database mutation occurred.
