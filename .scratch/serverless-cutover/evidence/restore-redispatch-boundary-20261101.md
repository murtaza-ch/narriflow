# Deferred restore registration boundary

The actual qualified 3/4/5 gate failed. Its source snapshot restore and metadata boundary were observed, but the original native hold/refusal and complete qualified restore acceptance were not established. This patch does not rescue that run, change its deadline or rewrite its evidence. Root owns stopping/fencing consumers and any later fresh 5/6/7 gate. No cloud or candidate database action was performed for this fix.

The source explains the observed redispatch backoff. `ExecutionRestoreService.run` committed a metadata receipt containing the next redispatch DID, then unconditionally called `register(result.dispatchIds)`. The fenced scheduler correctly refused that target. The dispatch module recorded a failed delivery and future retry time. In the real Workflow wrapper, `ExecutionDispatchPendingError` becomes a durable sleep. The old metadata instance could therefore wake, replay its committed receipt and fail registration again under its original fenced environment, competing with the closed operator for the same DID. Deploying a closed Worker did not make that old metadata command the owner of deferred registration.

The service now keeps the receipt and returned dispatch IDs unchanged, but derives the registration list inside the same transaction. A metadata page registers only proof-bound metadata continuations. Its redispatch successor remains pending for the explicit closed-mode operator. This applies on first execution and receipt replay, independently of the invoking Worker's environment. Redispatch pages retain ordinary registration behavior. No acknowledgement, delivery counter, retry time, epoch, owner, deadline or charged budget is reset or invented.

The PostgreSQL regression verifies the exact same DID, original committed receipt, zero delivery attempts, null acknowledgement and unchanged `nextDeliveryAt` across repeated metadata replay, including after the fixture switches to closed mode. The automatic dispatch collector stays silent. Explicit closed resume then registers that untouched DID immediately and preserves the receipt and reference.

The local workerd test runs the production `ScopedDomainWorkflow`, real Prisma/PostgreSQL transactions, production `deliverExecutionDispatches`, the actual fenced Worker scheduler and automatic collector. Injected empty domain phase handlers isolate the registration boundary. The actual metadata Workflow reaches `complete`; its redispatch row remains unacknowledged with zero attempts and no error, then remains unchanged after another 1.2 seconds. This tests runtime completion rather than merely catching a scheduler error. It uses the repository's existing Node/Wrangler execution pattern, localhost-only guards and a fresh disposable schema. No public endpoint or deployment was added.

Pinned Bun 1.3.6, PostgreSQL 17.11 on the dedicated localhost:55432 gate database, and 163 fresh migrations:

- Baseline source with the new regressions: two failures, including the actual workerd metadata command failing to complete. The original pure-PG red case failed with `boundary_registration_pending`.
- Corrected restore suite including actual workerd: 11 passed, 83 assertions. Workflow completion took about 3.6 seconds.
- Affected restore, maintenance factory, native restore and snapshot suites: 21 passed, 191 assertions, no skips.
- Scheduler, restore operator and dispatch retry fast suites: 16 passed, 153 assertions.
- Services typecheck, probe typecheck with pinned Workers types, focused Biome and diff checks pass.

Local logs: `/tmp/narriflow-restore-boundary-red.log`, `/tmp/narriflow-restore-boundary-workerd-red.log`, `/tmp/narriflow-restore-boundary-final-db.log`, `/tmp/narriflow-restore-boundary-final-workerd.log`, and `/tmp/narriflow-restore-boundary-fast.log`. The existing execution runner already includes this restore suite; no new runner alias or default fixture bypass is needed.
