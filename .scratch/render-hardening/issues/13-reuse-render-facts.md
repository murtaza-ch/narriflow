# 13 - Reuse compatible layout and immutable media facts

**What to build:** Avoid rerunning layout analysis and media/font validation when exact compatible facts are already available.

**Blocked by:** [12 - Retry transient layout analysis before center fallback](12-analysis-retry.md)

**Status:** ready-for-agent

**Suggested implementer:** Claude

**Contract:** [Render hardening spec](../spec.md). Read the relevant contract sections and AGENTS.md before claiming.

## File ownership

Exhaustive write set, relative to repository root. This ticket may also update its own issue file with status and evidence. All other paths are read-only. Shared paths are serialized by blocker ancestry. If an additional file is necessary, amend the write set and dependency edges before editing it.

- `apps/worker/src/tasks/clip-render-attempt.ts`
- `apps/worker/src/tasks/clip-render-attempt-runtime.ts`
- `apps/worker/src/tasks/auto-layout-analysis.ts`
- `apps/worker/src/brand-font-resolution.ts`
- `apps/worker/src/render-fact-cache.ts`
- `apps/worker/src/render-fact-cache.test.ts`
- `apps/worker/src/render-evidence-reuse.test.ts`
- `packages/services/src/clip.service.ts`
- `packages/services/src/layout-evidence.ts`
- `packages/services/src/layout-evidence.test.ts`

## Implementation

1. Re-read compatible durable evidence immediately before group planning without rereading mutable editor/entitlement state. Freeze the chosen evidence for the group.
2. Bind reuse to immutable source version, window/cuts/revision/preview/model/settings. Defer background analysis already covered by live render ownership. Keep source/proxy analysis separate if identical-plan tests do not establish interchangeability.
3. Cache complete source probe, selected-window asset validation and font bytes by immutable fingerprint/toolchain; existing Project.sourceProbe alone is insufficient. Refresh signed access locations independently.
4. Measure the duplicated detector work Claude found, with paired baseline/current samples, avoiding an unsupported promise that every clip gains 30–45%.

## Acceptance

- [ ] Evidence arriving after parent snapshot but before group plan causes zero redundant detector execution when its full fingerprint matches.
- [ ] Changed source/revision/cuts/preview/model/settings forces appropriate analysis; stale facts cannot change the plan.
- [ ] Source/proxy comparison either proves exact plan equality or reuse remains constrained to the same path.
- [ ] Cache hit/miss/deferred counts and analysis wall time appear in the report; no crop/cue/layer/argv/frame/PCM change in normal references.

## Verification

Run from repository root. The command interface below is delivered by ticket 01 where applicable. Run media checks inside the pinned image. Record output/evidence rather than merely listing commands.

```sh
bun test apps/worker/src/render-fact-cache.test.ts apps/worker/src/render-evidence-reuse.test.ts packages/services/src/layout-evidence.test.ts
bash .scratch/api-extraction/db-gate.sh bun run test:workflow:db
```

Run the full normal exact golden comparison from spec.md. For an approved defect ticket, also run its declared corrected expectations; preserve all unrelated baseline results.

`bun run lint` and `bun run typecheck` must pass for the assembled change. Capture scoped failures caused by unrelated in-flight work before changing any unowned file.

DB checks, when listed, must use `bash .scratch/api-extraction/db-gate.sh ...`; never run gates against shared Neon. No shared resource mutations or deployments are authorized by this ticket.

## Evidence

Pending. Record commit/image hashes, commands, fixture reports and any unresolved acceptance here.

## Comments
