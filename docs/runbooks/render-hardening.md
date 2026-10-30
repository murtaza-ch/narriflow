# Render hardening verification

Run media checks in the deployed worker image. Native macOS FFmpeg 8.0.1 and
Linux FFmpeg 7.1.5 are separate environments. Compare each candidate against a
baseline from the same image. Never replace the frozen macOS baseline with
Linux results. A same-image capture of the current hardening tree verifies
repeatability and defect contracts; it does not recreate the pre-hardening
Linux baseline, which was never captured.

## Image check without changing the running worker

The linked Railway project uses environment `dev` and service
`@narriflow/worker`. Start with:

```sh
bunx --bun @railway/cli ssh --service @narriflow/worker --environment dev
# Inside /app, read-only; prints safe version/hash facts, never environment secrets:
bun apps/worker/scripts/check-render-environment.ts --enforce --json
```

If local SSH has no key, use a temporary key registered with `railway ssh keys
add`, then `--identity-file`. Remove that registered key and local private key
after verification. Use `railway ssh config --dry-run` to inspect connection
routing. Accept a new host key into a task-specific known-hosts file. Do not
change the user's SSH configuration or disable host-key verification.

Create a temporary source directory in the container from `git archive` of the
reviewed commit. Link its workspace `node_modules` directories to those under
`/app`, and copy the reviewed changes into the temporary directory. Exclude env
files and credentials. The worker keeps running from `/app`; do not replace its
source files or restart it. Record `RAILWAY_GIT_COMMIT_SHA` and
`RAILWAY_DEPLOYMENT_ID` individually, source archive SHA-256, runtime fingerprint,
fixture toolchain ID and candidate file hashes. A deployment replaces the
container and its scratch files; restart verification if that occurs.

In the temporary directory:

```sh
# First use of this image's fixture toolchain. This pins only the scratch copy
# of the fixture manifest; retain that manifest with the report for replay.
bun apps/worker/scripts/render-golden.ts stage --pin
bun apps/worker/scripts/render-golden.ts capture --suite all --out /tmp/narriflow-golden/image-baseline-21
# Apply the reviewed candidate files to the temporary source directory.
bun apps/worker/scripts/render-golden.ts verify --baseline /tmp/narriflow-golden/image-baseline-21 --suite all --out /tmp/narriflow-golden/image-candidate-21
bun apps/worker/scripts/check-render-environment.ts --enforce --json
```

Download `capture.json`, `report.json`, `report.md`, environment JSON and the
scratch fixture manifest. Compare normal-case `targets[].plan` and
`targets[].command.argv` against the host candidate, documenting differences.
Frame and PCM hashes may differ across toolchains. Remove only this task's
scratch source, fixtures and outputs after retaining reports. Never delete
another worker's scratch or stop its process.

## Check an operator-submitted deployed render

The orchestrator submits the real render. Obtain its Workflow Run ID, capture
logs covering admission through terminal settlement, including every replica,
and inspect them without printing signed URLs:

```sh
bunx --bun @railway/cli logs --service @narriflow/worker --environment dev --json --lines 2000 > /tmp/render-worker.jsonl
bun apps/worker/scripts/render-telemetry-report.ts /tmp/render-worker.jsonl WORKFLOW_RUN_ID
```

The report deduplicates execution summaries by group token, gives phase and
attempt-wall p50/p95 with sample sizes, counts failure observations, fallbacks
and glyph omissions, and rejects missing validation for an accepted artifact.
Exit zero means those checks passed for the available log window. It does not
prove run completeness; compare the durable ledger and parent outcome below.
Expand the log window when any group is missing. Operation summaries have safe
group, project, clip and export IDs, revision, source/toolchain fingerprints,
retry limit and resource facts. `clip_render_delivery_latency` separates
request-to-ready from queue age; its lookup is best-effort after completion.

Inspect `clip_render_output_validation` for planned and measured duration,
canvas, SAR, clock, color, audio, bytes and decode checks. Check the optional
mix-peak diagnostics for music/SFX. `clip_composition_resources` records actual
detector counts, reused evidence kinds, probe/cache counters, graph/argument
bytes and decoder count. Reused evidence kinds count compatible facts, not a
promise that every fact avoids exactly one detector invocation. The paired
benchmark measures avoided detector invocations explicitly.

`clip_render_phase` uses UTC start/end and a monotonic elapsed duration.
`clip_render_attempt_metrics.phaseMs` sums operation durations including retries,
so overlapping upload/encode phases must not be added to estimate wall time.
Zero means no measured operation in that phase. Inspect phaseOperations with
phaseMs to distinguish a skipped operation. Compiler time is `compose`, output
full-decode checks are `validate`, and source probing is `probe`.

`render_group_released` counts executor/resource deferrals separately from
retryable/permanent media failures. Executor releases and orderly shutdown
refund charges. A started execution killed before orderly release retains its
charge and is recorded as interrupted when reaped. `render_replica_capacity`
contains active/waiting uploads and bytes, reservations, disk facts, process RSS,
cgroup current/peak/page-cache memory, CPU quota and active child count. A
cgroup peak is shared by processes and page cache, not per-encode RSS.
`render_group_settled.replicaBusyMs` measures occupied group wall time; use
nonoverlapping group spans per owner and the observation window for utilization.

Use a read-only DB session for these queries, substituting the reviewed run ID.
Do not run test suites against the shared development database.

```sql
-- Stable execution denominator, including executions that never started.
SELECT e."token", e."owner", e."claimedAt", e."startedAt", e."finishedAt",
       e."charged", e."result", e."errorCode", e."failureDisposition",
       e."sourceFingerprint", e."analysisFingerprint", e."toolchainFingerprint"
FROM "RenderGroupExecution" e JOIN "RenderGroup" g ON g.id = e."groupId"
WHERE g."workflowRunId" = 'WORKFLOW_RUN_ID'::uuid
ORDER BY e."claimedAt";

SELECT o."token", o."clipRenderId", o."result", o."errorCode", o."recordedAt"
FROM "RenderGroupVariantOutcome" o JOIN "RenderGroup" g ON g.id = o."groupId"
WHERE g."workflowRunId" = 'WORKFLOW_RUN_ID'::uuid;

-- Durable variant-start denominator. The suffix contains the variant ID.
SELECT "dedupeKey", "emittedAt" FROM "WorkflowEvent"
WHERE "workflowRunId" = 'WORKFLOW_RUN_ID'::uuid
AND "dedupeKey" LIKE '%:variant_started:%';

SELECT id, status, "chargedAttemptCount", "nextAttemptAt", "leaseExpiresAt"
FROM "RenderGroup" WHERE "workflowRunId" = 'WORKFLOW_RUN_ID'::uuid;
SELECT status, "requestedCount", "succeededCount", "failedCount"
FROM "WorkflowRun" WHERE id = 'WORKFLOW_RUN_ID'::uuid;
SELECT COUNT(*) AS terminal_notifications FROM "WorkflowEvent"
WHERE "workflowRunId" = 'WORKFLOW_RUN_ID'::uuid AND "notificationRequired";
```

Every requested member must have a completed, permanent/exhausted failed or
superseded outcome; terminal parents have no live group lease or future retry.
A non-superseded terminal run has one notification intent. Replaying completion
must not create another outcome or delete its referenced object. Compute media
failure rates over durable charged starts, reporting released/unstarted,
interrupted and superseded executions separately. Count variants over
per-token variant starts/outcomes. Never divide current failed ClipRender rows
by current total rows and label that an attempt failure rate.

## Reproducible local gates

```sh
bun apps/worker/scripts/render-golden.ts verify --baseline /tmp/narriflow-golden/baseline --suite all --out /tmp/narriflow-golden/candidate-21
bun test apps/worker/src/render-hardening.integration.test.ts apps/worker/src/render-diagnostic-adapter.test.ts
bash .scratch/api-extraction/db-gate.sh bun run test:workflow:db
bash .scratch/api-extraction/db-gate.sh bun run test:clip-editor-persistence:db
bash .scratch/api-extraction/db-gate.sh bun run test:social-publication:db
bash .scratch/api-extraction/db-gate.sh bun run test:vizard-expansion:db
bash .scratch/api-extraction/db-gate.sh bun run test:integration-api:db
bun run typecheck
bun run lint
bun run test
bun run --cwd apps/api test:inventory
bun run --cwd apps/api openapi:check
bun run check:web-split
```

The integration test's paired frozen workload reports five fresh/reused samples
with identical compiled encode arguments and detector counts. Detectors,
encoders and storage are injected, so its wall times cannot establish the
estimated 30–45% real-render opportunity. The DB replica benchmark uses three
samples each of one/two replicas, four groups and eight variants, real leases
and injected 120ms encodes/1000-byte uploads. It measures scheduling overhead
and concurrency; byte parity comes from the separate native golden gate.
Neither benchmark is a production throughput claim.

The in-image check found a golden measurement bug: MP4's average-rate tag can
omit the final packet duration. Golden assertions now derive average rate and
presentation duration from decoded PTS plus the final frame interval, and keep
`output.containerAvgFrameRate` for the raw tag. Decoded frames/PTS, encoder
arguments, production validation and every expected contract remain unchanged.
The 137-frame cut/audio fixture spans 138 clock positions on both builds; the
90-frame VFR fixture spans exactly six seconds at 15 fps. Frame counts alone
cannot replace presentation timestamps when a cut leaves a clock gap.

A `variant_started` event means pending-to-rendering acquisition. Join its token
with the execution's `startedAt`/`charged` fields to distinguish media execution
from an unstarted executor release. Native SIGKILL recovery is exercised by the
workflow DB suite in a child process connected only to its disposable schema.
