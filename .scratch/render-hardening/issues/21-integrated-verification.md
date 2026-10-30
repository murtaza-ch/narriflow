# 21 - Record durable attempt telemetry and verify integrated recovery

**What to build:** Produce reproducible parity, fault recovery and throughput evidence for the complete hardening change.

**Blocked by:** [20 - Execute one leased render group per replica](20-render-group-worker.md), [15 - Bound multipart abort and preview storage lifetimes](15-bounded-storage-cleanup.md)

**Status:** done

**Suggested implementer:** Sol

**Contract:** [Render hardening spec](../spec.md). Read the relevant contract sections and AGENTS.md before claiming.

## File ownership

Exhaustive write set, relative to repository root. This ticket may also update its own issue file with status and evidence. All other paths are read-only. Shared paths are serialized by blocker ancestry. If an additional file is necessary, amend the write set and dependency edges before editing it.

- `apps/worker/src/render-diagnostic-adapter.ts`
- `apps/worker/src/render-diagnostic-adapter.test.ts`
- `apps/worker/src/tasks/clip-render-attempt.ts`
- `apps/worker/src/tasks/clip-render-attempt-runtime.ts`
- `apps/worker/src/index.ts`
- `apps/worker/src/render-hardening.integration.test.ts`
- `packages/services/src/render-group-lifecycle.ts`
- `packages/services/src/render-group-lifecycle.db.test.ts`
- `.scratch/render-hardening/spec.md`


### Authorized write-set amendment, 2026-10-30

The orchestrator adds parent-only fixture migration/removal, phase and taxonomy telemetry, deployed-image verification/font pins, and an operator telemetry check. Tickets 01–20 are closed predecessors; no new concurrent owner. Additional owned paths:

- `packages/services/src/workflow-run-lifecycle.ts`
- `packages/services/src/index.ts`
- `packages/services/src/render-group-test-fixture.ts`
- `packages/services/src/generation-finishing.db.test.ts`
- `apps/worker/runtime-lock.json`
- `apps/worker/scripts/render-golden.ts`
- `apps/worker/scripts/render-golden.test.ts`
- `apps/worker/src/render-group-executor.ts`
- `apps/worker/src/render-group-executor.test.ts`
- `apps/worker/src/tasks/clip-render-attempt.test.ts`
- `apps/worker/src/tasks/clip-render-attempt.fixture.test.ts`
- `apps/worker/src/tasks/clip-render-attempt-core-paths.fixture.test.ts`
- `apps/worker/src/tasks/clip-render-attempt-core-paths.test.ts`
- `apps/worker/scripts/render-telemetry-report.ts`
- `docs/runbooks/render-hardening.md`
- `docs/adr/0003-clip-render-attempt.md`
- `packages/services/src/workflow-run-lifecycle.db.test.ts`
- `packages/services/src/render-group-replicas.db.test.ts`
- `packages/services/src/clip-export-retry.db.test.ts`
- `packages/services/src/render-group-lifecycle.db.test.ts`
- `packages/services/src/mcp-task.db.test.ts`
- `packages/services/src/workspace-event-emission.db.test.ts`
- `packages/services/src/operation-receipt.db.test.ts`
- `packages/services/src/generation-finishing-transition.db.test.ts`

Read-only SSH verification is authorized by the task. No deployment, env edits, or shared DB writes. Temporary image verification files are removed after reports are retrieved.

## Implementation

1. Fill remaining telemetry gaps using the spec field contract. Persist idempotent compact group/variant start/outcomes in the existing event/ledger model so mutable rows no longer define attempt denominators.
2. Run the full golden/fault matrix, including process-start, partial retries, true manual export retry, analysis retry/exhaustion, corrupt/truncated output, storage hang, disk pressure and ambiguous completion.
3. Compare frozen workloads with/without reusable evidence and with one/two replicas. Report samples, wall-time p50/p95, detector executions, repeated work, upload bytes/backlog and resource peaks with correct denominators.
4. Record reproducible command/image/commit hashes and failures in this ticket; close the spec only after every ticket and integrated gate passes. This ticket does not authorize deploying, mutating shared DB, killing user processes or pushing.

## Acceptance

- [x] Structured telemetry includes safe IDs/fingerprints/phase/timing/retry/failure/errno/resources/output facts and redacts signed URLs/secrets/user caption text.
- [x] Durable start/outcome history distinguishes media attempts, unstarted executor releases, crashes and supersession without duplicate terminal events.
- [x] Full normal exact parity and all activated defect contracts pass; no normal baseline was refreshed to hide drift.
- [x] Every injected failure reaches bounded retry/degradation/permanent success/failure correctly, with no ready invalid output or deleted referenced object.
- [x] All repository and disposable DB gates below pass; performance results state sample sizes and limits, including whether the 30–45% opportunity was realized.

## Verification

Run from repository root. The command interface below is delivered by ticket 01 where applicable. Run media checks inside the pinned image. Record output/evidence rather than merely listing commands.

```sh
bun test apps/worker/src/render-hardening.integration.test.ts apps/worker/src/render-diagnostic-adapter.test.ts
bash .scratch/api-extraction/db-gate.sh bun run test:workflow:db
bash .scratch/api-extraction/db-gate.sh bun run test:clip-editor-persistence:db
bun run lint
bun run typecheck
bun run test
bun run --cwd apps/api test:inventory
bun run --cwd apps/api openapi:check
bun run check:web-split
```

Run the full normal exact golden comparison from spec.md. For an approved defect ticket, also run its declared corrected expectations; preserve all unrelated baseline results.

DB checks, when listed, must use `bash .scratch/api-extraction/db-gate.sh ...`; never run gates against shared Neon. No shared resource mutations or deployments are authorized by this ticket.

## Evidence

Implementation and integrated verification recorded below. All changes remain uncommitted.

## Comments


### Implementation and verification, 2026-10-30

- Removed the parent-only variant/analysis writers, their fence, render-claim resets, parent-only settlement/retry/child-recovery branches, generic render completion and unused disposition export. Parent coordination never rewrites group-owned media. A single test-only `RenderFixtureLifecycle` supplies render fixtures through real group admission/start/outcome/finish. Migrated eight former caller suites plus the finishing fixture that previously changed only public variants. Updated old parent-retry assertions to group backoff/charges. Child success/permanent-failure events still publish transactionally before unrelated groups settle, preserving Task history.
- Added idempotent per-token/per-variant start events alongside existing immutable execution/outcome records. Added phase operation durations and summaries, source hashes/IDs/revisions/group/toolchain context, taxonomy/fallback/glyph counters, request-to-ready/queue age, capacity snapshots and separate worker RSS/cgroup current/peak/page-cache/CPU/child facts. Diagnostic failure cannot reverse settlement. Credentials/URLs/raw caption/error text are redacted. Test setup moved into reusable test modules so the focused integration gate registers only its own tests.
- Operator instructions and read-only ledger queries: `docs/runbooks/render-hardening.md`; JSONL checker: `apps/worker/scripts/render-telemetry-report.ts`; model and denominator changes: ADR 0003. No real deployed render submitted; the orchestrator owns that separately authorized check.

#### Image evidence and inherited deferrals 01–17

- SSH initially failed with `No SSH keys found in your SSH agent or ~/.ssh/`. A task-only ed25519 key registered through the logged-in CLI worked. Host-key verification used a task-specific known-hosts file, without altering user SSH config. The temporary Railway key was removed successfully and its local private/public files deleted.
- Ran `check-render-environment.ts --enforce --json` inside the actual Railway worker, environment dev/service @narriflow/worker, exit 0. Actual Linux x64 Debian 13/Bun 1.3.6/FFmpeg 7.1.5, including zscale/tonemap. All 13 `expectedSha256` font probes are filled from that run and match the final running image too. Keep apt Noto/system fonts: drawtext text layers/watermarks still use those families; vendored captions/emoji retain their existing deterministic assets.
- Deployment during the accepted image gate: `8c1da225-eefe-4eaf-9e66-21abca723f49`, deployed/source archive commit `19053e06641c4d299d4e5483c11db8df7efe7ebc`. Source archive SHA-256 `201c7308537699f197f509b7f1ee98a59724277d35d80d494772faa839a94835`. Pinned base image remains `oven/bun:1.3.6@sha256:f20d9cf365ab35529384f1717687c739c92e6f39157a35a95ef06f4049a10e4a`. The lock pins provider image, native packages, model and Python wheels. Built Railway OCI digest is not exposed by SSH; deployment ID, full binary/font/runtime fingerprints and copied-source hashes are retained instead. Full provenance: `/tmp/narriflow-ticket21/provenance.json`.
- The DB-free source archive/candidate ran under `/tmp/nf21-image`, with workspace dependency links to `/app`. It never replaced running-worker source. The image's fixtures were generated/pinned once in that scratch copy; its manifest is retained in `/tmp/narriflow-ticket21/nf21-image/apps/worker/src/__fixtures__/render-golden/manifest.json`. Existing host fixtures/manifest/baseline were never repinned.
- Accepted baseline: `/tmp/narriflow-golden/image-baseline-21-fixed` inside that image, captured after the orchestrator's `19053e06` validator fix. The first capture, before that fix, rejected five normal outputs and was not accepted as a reference. The scratch archive has no `.git`, hence blank commit fields in the capture; provenance records the source commit/archive hash independently.
- First candidate found two **measurement** contract failures. Actual frame counts and decoded timestamps already match host: audio-late-cut-scene-music has 137 frames across 138 clock positions; VFR has 90 frames at 15 fps over six seconds. FFmpeg 7's MP4 average-rate tag omits the final duration. Fixed only golden measurement to use decoded presentation PTS plus the final frame interval, retaining the raw tag separately. No encoder, validator, expected contract or accepted baseline changed. Truncation still fails its frame-span/count contracts; a unit test covers that boundary.
- Final image command: `bun apps/worker/scripts/render-golden.ts verify --baseline /tmp/narriflow-golden/image-baseline-21-fixed --suite all --out /tmp/narriflow-golden/image-candidate-21-clock`, **exit 0**, 18/18 normal exact, 16/16 activated defects, 2 unchanged rotation/reflection guards, no drift/xpass. Image fingerprint `f96b20d189e39146f1d495b88a6225961f646a0481e632a06fa5324a8af7430f`, fixture toolchain `e00c091bc5a81bee`. Candidate capture SHA-256 `45fee77d1b53ec8ab43aaabcf200d580c60efb19f2db9ee1809f7fd2023b2a4f`.
- Downloaded full capture/report before an operator deployment replaced that container and removed its scratch. Reports: `/tmp/narriflow-ticket21/narriflow-golden/image-candidate-21-clock/{report.md,report.json,capture.json}`; baseline capture retained beside it. Worker health was checked afterwards: HTTP 200, `ok:true`. Final `/app` enforced environment check also passed and all font pins matched. No worker was stopped/restarted by this implementer.
- Host/image comparison: every normal plan is identical. **All 18 normal cases** have one raw argv spelling difference: image dependency links resolve the caption font directory to `/app/packages/caption-fonts/fonts/`, while host normalizes it to `{repo}/packages/caption-fonts/fonts/`. After normalizing this font root, every normal argv is identical. Per-case list: `/tmp/narriflow-ticket21/host-image-normal-plan-argv.json`. Cross-toolchain frames/PCM are not claimed identical. This closes the Linux audio/limiter, HDR, glyph, graph-transport, validation and startup deferrals from 01–17.

#### Fault and recovery matrix

| Fault | Exercised boundary and result |
| --- | --- |
| HTTP interruption/exit zero, corrupt/truncated output | Native host and image golden cases plus output-validation suites: typed rejection, no upload/ready invalid artifact. |
| Sync/async spawn/EBADF, helper startup/readiness | Worker process, executor health, source and attempt tests: quarantine/release, no full-source repair download or permanent poisoning. |
| Transient/exhausted analysis, late compatible evidence | Layout/attempt suites: bounded retries, center degradation only after exhaustion, no durable infrastructure evidence; paired reuse skips detectors with identical argv. |
| Mixed siblings, manual export retry, supersession | Disposable workflow/integration gates call the real services; completed bytes stay settled, only unsettled members retry; one terminal notification. |
| Ambiguous commit/analytics failure/cleanup hang | Attempt, group lifecycle and storage tests preserve referenced objects, keep uncertainty, bound cleanup independently. |
| Disk/backlog pressure, stalled multipart abort, preview shutdown | Resource-budget, storage/preview suites prove bounded deferral/drain/cancellation with finite cleanup. |
| Real SIGKILL | A new Bun child owns/starts a real disposable-DB group, commits one variant, starts its sibling, then is SIGKILLed by its test parent. Reaping charges once, preserves committed output, a successor renders only the unfinished member, parent completes. 14 assertions. |
| Coordinator/replica death and 1/2 replicas | Real DB leases/executor loops, one CPU lane per replica; reaping/replacement preserve healthy leases, membership and one notification. |

#### Performance, correct denominators and limits

- Frozen scheduling workload: four groups/eight variants, three samples each, real PostgreSQL lifecycle, **injected** 120ms encode and 1000-byte upload per variant. Latest full-gate one-replica p50/p95 **1175.167/2083.881 ms**; two-replica **916.390/1334.296 ms**. Eight unique completed variants, zero repeated variants, 8000 simulated uploaded bytes per batch; injected synchronous uploads have no waiting backlog. Raw per-replica busy spans and all samples are in `/tmp/narriflow-ticket21/workflow-db-complete.log`. Small n and other host activity explain dispersion; this is scheduler evidence, not native encode/network throughput.
- Five paired frozen-document reuse samples, real planner/compiler, injected detectors/encoder/storage: fresh p50/p95 **2.261/7.324 ms**, reused **2.126/3.404 ms**. Fresh per sample: one extraction plus face/PiP detectors; reused: zero of each. Ten detector invocations avoided across five pairs, exact encode args in every pair, no repeated encode work. Sampled worker RSS max **171999232 bytes**, sampled at the five reuse-attempt ends, excludes native detector/encoder/storage work. Logs `/tmp/narriflow-ticket21/integration-complete.log`.
- **The proposed 30–45% native analysis/throughput improvement is not established.** Native detector cost, real upload/network backlog, per-encode process/cgroup resource peaks and production request-to-ready were not benchmarked here. Runtime logs now expose those fields; the runbook explains the operator measurement. No mutable ClipRender snapshot is used as an attempt denominator. Native media parity and fault correctness are measured separately from simulated throughput.

#### Gates

All DB commands used `bash .scratch/api-extraction/db-gate.sh`, never shared Neon.

- Host parity to `/tmp/narriflow-golden/candidate-21`: **exit 0**, 18 normal exact + 16 corrected + 2 unchanged guards. Report at that path, log `/tmp/narriflow-ticket21/parity-final.log`.
- Focused golden + integrated telemetry/redaction suites: **39 pass, 0 fail**, `/tmp/narriflow-ticket21/focused-final.log`. Final focused integration/diagnostic check after resource sampling: **9 pass, 0 fail**; final telemetry/executor security check: **22 pass, 0 fail**.
- `bun test` in apps/worker: final frozen-tree direct run **1132 pass, 0 fail**, `/tmp/narriflow-ticket21/worker-all-closed.log`; earlier direct run **1130 pass, 0 fail** before fixture extraction; final repository `@narriflow/worker:test` invokes `bun test src/` in apps/worker, **1102 pass, 0 fail**, `/tmp/narriflow-ticket21/root-tests-final.log`. The root package command omits the 30 script tests; the focused golden gate runs them separately. Fixture extraction prevents the focused integration command from registering unrelated suites. An intermediate run picked up the orchestrator's new timebase-rounding test before its fix; the final repository run includes the committed fix and passes. A later aggregate run straddled this implementer's token-redaction edit and ran the old cached module with the new assertion; the final direct gate passed on the frozen tree.
- Services `bun test`: **1426 pass, 880 DB skips, 0 fail**, `/tmp/narriflow-ticket21/services-tests-final.log`; actual DB gates below run the skipped invariants.
- Workflow: **206 pass, 0 fail**, `/tmp/narriflow-ticket21/workflow-db-complete.log`, includes actual SIGKILL and benchmark. Clip editor persistence: **38 pass, 0 fail**. Social publication: **125 pass, 0 fail**. Vizard expansion: **100 pass, 0 fail**. Integration API: **155 pass, 0 fail**, including MCP/operation receipts/finishing, `/tmp/narriflow-ticket21/final-integration-api-db-6.log`. All required commands exit 0.
- `bun run test`: **10/10 tasks successful**, root env/split tests also pass. `bun run typecheck`: **15/15 successful**. `bun run lint`: **exit 0**, 11 existing warnings/1 info. Owned-path Biome and `git diff --check` clean. Final logs use `/tmp/narriflow-ticket21/{root-tests-final,typecheck-closed,lint-closed,biome-closed}.log`.
- API inventory **281 mounted/44 protocol routes, 0 problems**; OpenAPI check **31 operations match**; web split passes. Logs `/tmp/narriflow-ticket21/{inventory,openapi,web-split}.log`.

No commit/push/deploy/env edit/shared DB mutation. Only the test-owned SIGKILL child was terminated. The pre-existing untracked browser note and concurrent orchestrator fixes were left alone. Ticket 20's retained parent-only persistence acceptance is resolved by this ticket. No changes requested from another owner. Remaining operator action is the real deployed render/telemetry check explicitly reserved to the orchestrator.
