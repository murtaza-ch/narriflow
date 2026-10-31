# Render verification

Media executes in the pinned Linux x86_64 native image. Workers own admission,
leases, artifact verification and settlement; the Render Run parent waits
without a lease. Use the [native CI commands](../../apps/media/scripts/gates/native-ci.md)
for a credential-free image check. Runtime versions are Bun 1.3.6,
Python 3.13.5 and FFmpeg 7.1.5; enforce the runtime-lock fingerprint before
interpreting media results.

## Exact media parity

Compare against the frozen pre-cutover reference
`623aadca7e5790cf456100f7b7966fbaf74e8bf7`. The evidence in
`.scratch/serverless-cutover/evidence/render-thread-policy-20261031.json`
records the exact 36-case Linux comparison, checker provenance and permitted
diagnostic-only normalization. Preserve plans, encode arguments, frames, PCM,
probe and validation facts. A capture of the candidate cannot replace the
reference. Do not refresh goldens or relax tolerances to clear a failure.

Run the reviewed checkout in the locked image without host environment files
or external network access. Retain the source commit, source archive SHA256,
runtime fingerprint, fixture toolchain ID, complete comparison reports and
bounded crash/resource evidence. Do not modify a running application or stop
another operation to run a gate.

## Inspect an accepted render

Use the exact Workflow Run ID and its Render Group IDs to inspect the Worker
and native invocation logs. `clip_render_attempt_metrics` carries measured
phase durations and detector counts; `clip_composition_resources` describes
composition resources; `clip_render_output_validation` records media validation.
`render_native_child_unconfirmed` carries bounded failure diagnostics. Log
availability and format depend on the emitting boundary; these records do not
replace the durable ledger or prove completeness. Never print scoped URLs,
request bodies, credentials or captions while collecting diagnostics.

Use a read-only database connection for the following exact-run queries.
Substitute the reviewed UUID; do not run test suites against shared data.

```sql
SELECT g.id, g.status, g."chargedAttemptCount", g."nextAttemptAt",
       g."leaseExpiresAt", g."operationDeadlineAt",
       e.token, e.owner, e."claimedAt", e."startedAt", e."finishedAt",
       e.charged, e.result, e."errorCode", e."failureDisposition"
FROM "RenderGroup" g
LEFT JOIN "RenderGroupExecution" e ON e."groupId" = g.id
WHERE g."workflowRunId" = 'WORKFLOW_RUN_ID'::uuid
ORDER BY g.id, e."claimedAt";

SELECT g.id, a."attemptToken", a.status, a."processStartedAt",
       a."leaseExpiresAt"
FROM "RenderGroup" g
JOIN "ExecutionDispatch" d
  ON d."subjectKind" = 'render_group' AND d."subjectId" = g.id::text
JOIN "ExecutionAttempt" a ON a."dispatchId" = d.id
WHERE g."workflowRunId" = 'WORKFLOW_RUN_ID'::uuid;

SELECT o.token, o."clipRenderId", o.result, o."errorCode", o."recordedAt"
FROM "RenderGroupVariantOutcome" o JOIN "RenderGroup" g ON g.id = o."groupId"
WHERE g."workflowRunId" = 'WORKFLOW_RUN_ID'::uuid;

SELECT status, "requestedCount", "succeededCount", "failedCount",
       "attemptId", "leaseOwner", "leaseExpiresAt"
FROM "WorkflowRun" WHERE id = 'WORKFLOW_RUN_ID'::uuid;
```

An acquired owner has permission to start; the actual child spawn must precede
the acknowledged `process-start` command. Before that acknowledgement the
child cannot receive its work command. An unstarted rejection or release costs
zero. Every started execution retains its charge on shutdown, cancellation,
expiry and exact release replay. A successor starts only unfinished variants
and consumes its own charge; the per-group budget never decreases.

Every requested member must have a completed, permanent/exhausted failed or
superseded outcome before the parent settles. Completed sibling objects and
historical outcomes survive retries and lost acknowledgements. A settled
parent has no live group lease or scheduled retry. Count media failures over
durable charged starts, reporting unstarted releases, interrupted and
superseded executions separately. Current failed ClipRender rows are not an
attempt failure rate.

## Resource and source-read evidence

Measure actual native preparation followed by rendering for every selected
window. Include original-source reads made by preview, peaks and layout
analysis, plus rendering; a render-only window is not the aggregate gate.
Report source provenance and encoded size, all completed outputs, upstream
bytes, index/header bytes, encoded payload bytes and the configured profiles.
The preparation profile is2 CPU / 4 GiB; rendering is4 CPU / 8 GiB. The per-operation
immutable source cache is bounded at 64 MiB and 128 entries. Cache hits still
require live owner permission. Successful socket writes do not prove FFmpeg
consumed those bytes; upstream bytes remain the transfer denominator.

The three-hour 12-window representative-source result and the separate compact,
index-heavy failure diagnostic must remain visible together. Generated test
audio must be disclosed; this media benchmark does not prove STT, provider
behavior or conversational lip sync. Sampled process-tree RSS is not cgroup
peak memory. No local fixture establishes production throughput or latency.

## Durable control gates

Run targeted PostgreSQL tests through the disposable-schema runner:

```sh
bun packages/services/scripts/run-workflow-db-tests.ts \
  packages/services/src/render-group-replicas.db.test.ts
bun packages/services/scripts/run-execution-db-tests.ts \
  packages/services/src/clip-preparation.db.test.ts
bun test packages/services/src/render-group-contract.test.ts
```

Supply only the isolated test database variables required by the runner. The
replica suite uses current Generic Core admission and sealed preparation
inputs, including actual child-start accounting, lost release acknowledgement,
completed-sibling preservation and unfinished-only retry. Native SIGKILL and
image resource gates complement these controlled domain/storage tests; they
do not substitute for a live Worker→native→R2 run.
