# 12 - Retry transient layout analysis before center fallback

**What to build:** Prevent transient detector/extraction failures from silently or durably changing framing before retries are exhausted.

**Blocked by:** [10 - Preserve uploaded outputs across ambiguous completion](10-commit-safe-delivery.md), [11 - Retry transient siblings and repair manual export admission](11-retry-lineage.md)

**Status:** done

**Suggested implementer:** Sol

**Contract:** [Render hardening spec](../spec.md). Read the relevant contract sections and AGENTS.md before claiming.

## File ownership

Exhaustive write set, relative to repository root. This ticket may also update its own issue file with status and evidence. All other paths are read-only. Shared paths are serialized by blocker ancestry. If an additional file is necessary, amend the write set and dependency edges before editing it.

- `apps/worker/src/layout-evidence.ts`
- `apps/worker/src/layout-evidence.test.ts`
- `apps/worker/src/layout-evidence-runtime.ts`
- `apps/worker/src/layout-evidence-runtime.test.ts`
- `apps/worker/src/tasks/clip-render-attempt.ts`
- `apps/worker/src/tasks/clip-render-attempt-runtime.ts`
- `apps/worker/src/tasks/clip-render-attempt-core-paths.test.ts`
- `apps/worker/src/tasks/auto-layout-analysis.ts`
- `apps/worker/src/tasks/auto-layout-analysis.test.ts`
- `packages/services/src/layout-evidence.ts`
- `packages/services/src/layout-evidence.test.ts`
- `apps/worker/src/__fixtures__/render-golden/expected/12-analysis-retry.json`
- `apps/worker/scripts/render-golden.ts`
- `apps/worker/scripts/reframe_detect.py`
- `apps/worker/scripts/pip_detect.py`
- `packages/composition-plan/src/clip-composition-plan.ts`

## Implementation

1. Propagate typed infrastructure failures through extraction and detectors instead of returning null. Distinguish content absence from process/storage failure.
2. Implement the spec's bounded analysis substep: at most three operations per group execution with cancellable 1s/2s delays, rebuilding failed segment/detector promises. This budget is independent of parent claims spent on unrelated work. Only exhaustion uses flagged center crop; process-start/configuration failure exits to executor recovery. Background retries use their existing durable schedule, never durable failed evidence.
3. Persist only valid content outcomes; reset existing local/dev infrastructure-failure evidence through a targeted operation recorded here, without querying or mutating shared development data as a test.
4. Keep permanent invalid source and ownership cancellation out of degradation. Record framing_degraded, attempts and causal code for terminal fallback; successful final-attempt evidence wins.

## Acceptance

- [x] Transient extraction and detector failures retry without output/failure-envelope persistence, then success produces the original expected crop. No failed promise is reused as a retry.
- [x] After exactly three transient analysis operations, automatic/screen/split exhaustion uses explicit center crop and a visible notice, never a cached transient failure. A first analysis on the last parent claim still gets its full substep budget.
- [x] No-trustworthy-faces is cacheable content evidence; malformed source and lost ownership retain their typed outcomes.
- [x] Normal successful analysis references remain exact. Existing transient cached envelopes are cleared rather than accepted through a compatibility parser.

## Verification

Run from repository root. The command interface below is delivered by ticket 01 where applicable. Run media checks inside the pinned image. Record output/evidence rather than merely listing commands.

```sh
bun test apps/worker/src/layout-evidence.test.ts apps/worker/src/layout-evidence-runtime.test.ts apps/worker/src/tasks/auto-layout-analysis.test.ts packages/services/src/layout-evidence.test.ts
bash .scratch/api-extraction/db-gate.sh bun run test:workflow:db
```

Run the full normal exact golden comparison from spec.md. For an approved defect ticket, also run its declared corrected expectations; preserve all unrelated baseline results.

`bun run lint` and `bun run typecheck` must pass for the assembled change. Capture scoped failures caused by unrelated in-flight work before changing any unowned file.

DB checks, when listed, must use `bash .scratch/api-extraction/db-gate.sh ...`; never run gates against shared Neon. No shared resource mutations or deployments are authorized by this ticket.

## Evidence

Implemented on `dev`, starting HEAD `7090c53622437d4712934c5a39c5bbc3a6968321`. Concurrent ticket 15 was committed by its owner during this work; integration HEAD is `2b6186d9f3883d488485ec009784d645e92ed35c` plus this ticket's uncommitted write set. No commits, env edits, dependency changes, shared-resource mutations, deployments, or process termination by this implementer. Ticket 15 files were not edited.

Implementation:
- One `LayoutEvidence` owner bounds the foreground analysis substep to three operations across the requested engines, independent of parent claim count. Delays are cancellable 1s/2s. Failed segment/multi-face promises reset; paired detectors drain before retry, with ownership, source and executor failures taking precedence. Valid completed engines can be reused within the group. A new group execution gets a new owner and budget, allowing at most nine operations across three charged executions.
- Third-operation success wins. Exhaustion supplies center availability and a `framing_degraded` plan notice carrying attempts and the original cause. Screen uses a full center crop instead of retaining its old two-tile failure fallback. Scene speaker selections also get an explicit center crop and causal notice. Render-resource diagnostics include `analysisAttempts` and its limit.
- Runtime extraction and detectors retain typed process/storage failures. Python inference exceptions and zero decoded frames now exit unsuccessfully; real no-face samples remain valid content. Process startup/configuration errors escape both attempt failure handlers without failing or settling variants, for executor recovery. Known permanent source errors and ownership cancellation propagate unchanged.
- Background analysis performs one operation per durable claim and uses its existing deferred retry schedule. It never publishes failed evidence. Startup/configuration errors defer safely and propagate to executor recovery.
- New failures are never persisted as reusable Screen/Split infrastructure evidence. Valid no-face analysis and conclusive Split content outcomes remain cacheable. Existing infrastructure envelopes cannot short-circuit fresh analysis.
- Added the explicit, bounded `LayoutEvidenceLifecycle.resetTransientFailures(reviewedClipIds)` repair operation. Its two guarded JSON updates clear only failed `analysis_unavailable`/`detection_unavailable` envelopes, atomically and idempotently, for 1-1000 supplied IDs. It does not scan or mutate shared development data automatically.

Parity prerequisite:
- Extracted `deriveRenderCompositionEvidence` from the real attempt and made the golden runner call it before retry behavior changed. Frozen fixtures retain their explicit provisional evidence state; production uses settled availability. The initial check caught this state distinction through plan fingerprints and was corrected without refreshing the baseline.
- Extraction-only required gate: **exit 0**, 18/18 normal references identical, 16 existing corrected references passing, two existing guards unchanged. Report `/tmp/narriflow-golden/candidate-12-extraction/report.md`; log `/tmp/narriflow-golden/verify-12-extraction.log`.

Verification:
- `bun test` from `apps/worker`: **973 pass, 0 fail**, 52 files, 5375 assertions. Log `/tmp/ticket12-worker-tests.log`.
- `bun test apps/worker/src/layout-evidence.test.ts apps/worker/src/layout-evidence-runtime.test.ts apps/worker/src/tasks/auto-layout-analysis.test.ts packages/services/src/layout-evidence.test.ts`: **54 pass, 1 opt-in DB test skipped, 0 fail**. Log `/tmp/ticket12-focused.log`. The skipped reset test passed separately through `db-gate.sh` below.
- Core attempt regressions cover an exhausted analysis on parent claim three, Screen fallback without failure-envelope persistence, immediate executor-error propagation without settlement, and the unchanged command-budget boundary. The real helper fault test runs actual Python with deterministic injected OpenCV failures and unreadable-frame responses.
- `bun test packages/composition-plan/src/clip-composition-plan.test.ts`: **55 pass, 0 fail**. Log `/tmp/ticket12-planner-tests.log`.
- `bash .scratch/api-extraction/db-gate.sh bun run test:workflow:db`: **184 pass, 0 fail**, seven files, disposable local PostgreSQL only. Log `/tmp/ticket12-workflow-db.log`.
- `bun run --cwd apps/worker typecheck`, `bun run --cwd packages/services typecheck`, and `bun run --cwd packages/composition-plan typecheck`: **exit 0**. Logs `/tmp/ticket12-{worker,services,plan}-typecheck.log`. Final `bun run typecheck`: **15/15 successful**, log `/tmp/ticket12-root-typecheck.log`.
- Scoped `bunx biome check` on all 13 owned TypeScript paths: **clean**. Log `/tmp/ticket12-biome.log`. Real Python fault tests verify the modified helpers' syntax and behavior. `bun run lint`: **exit 0**, 11 existing warnings and one info, log `/tmp/ticket12-root-lint.log`. `git diff --check`: clean.
- Required final parity command: `bun apps/worker/scripts/render-golden.ts verify --baseline /tmp/narriflow-golden/baseline --suite all --out /tmp/narriflow-golden/candidate-12`: **PASS, exit 0**. Normal **18/18 identical**, **16 corrected references passing**, two existing guards unchanged, zero mismatches/xpass. Exact plans/crops/cues/layers/argv/graphs/decoded frames/PTS/PCM retain the original baseline. Report `/tmp/narriflow-golden/candidate-12/report.md` and `report.json`; log `/tmp/narriflow-golden/verify-12.log`. This final run includes both Python helper changes and the final attempt/planner wiring.

## Comments

Write-set amendment, 2026-10-29: add the golden runner to use the extracted production evidence derivation before behavioral changes, and the composition planner for explicit exhausted-analysis center fallback and visible notices, including Screen mode. Ticket 08, the last planner owner, is complete and is an ancestor through 09/10; no concurrent ownership overlap.

Write-set amendment: add the existing core attempt tests, serialized through ticket 10. They asserted one-shot extraction degradation and persisted transient Screen failure, both explicitly replaced by this ticket. Their default fake Python command also threw for successful no-face analysis; make that a genuine empty content result so unrelated budget tests do not spend the three-second retry delay.

Write-set amendment: include both detector scripts. `reframe_detect.py` caught inference exceptions as no-face content, and both helpers could return cacheable-looking empty results after decoding zero frames. These must emit failing process outcomes for the typed runtime adapter; successful detections and valid no-face samples retain their existing bytes. Script consumers are serialized through ticket 08 and the attempt lane.


Operational reset and environment limits:
- `ALLOW_LAYOUT_EVIDENCE_RESET_DB_TESTS=1 bash .scratch/api-extraction/db-gate.sh bun test packages/services/src/layout-evidence.test.ts`: **5 pass, 0 fail**. A disposable local schema contains transient failure envelopes, content outcomes and nonfailure JSON. The actual Prisma repair clears two transient rows in each field, preserves content and unselected rows, and reports zero changes on replay. The schema is dropped afterward. Log `/tmp/ticket12-reset-db.log`.
- Shared development repair is an operator step: call `getLayoutEvidenceLifecycle().resetTransientFailures(reviewedClipIds)` for explicitly reviewed IDs. No shared query/reset was run, consistent with this ticket's prohibition on shared-resource mutations. No legacy analysis parser or dual reader was added.
- The unchanged ticket-01 host adaptation applies: macOS arm64, Bun 1.4.2 / FFmpeg 8.0.1, fingerprint `90cf30a30583bbe5`, baseline commit `5680477046`. Neither Docker nor Podman is installed. No Linux image build or verification is claimed; pinned Linux verification remains ticket 21's recorded gate.
- No normal baseline or corrected-media expectation was changed. Analysis failure semantics are tested through injected failures, the real Python helpers, the real attempt, shared evidence derivation and planner. No empty `expected/12-analysis-retry.json` activation file was added, since there is no new frozen media defect case to activate.


Close-out: all ticket-12 implementation and verification acceptance checks pass. Changes are uncommitted. Deviations are the recorded necessary write-set additions and the inherited ticket-01 host verification adaptation. Operator follow-up is the reviewed-ID shared development reset; it was not run as a test or hidden in a parser. Pinned Linux/image verification remains with ticket 21. No code changes requested from another owner.
