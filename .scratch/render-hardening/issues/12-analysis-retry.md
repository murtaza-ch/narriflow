# 12 - Retry transient layout analysis before center fallback

**What to build:** Prevent transient detector/extraction failures from silently or durably changing framing before retries are exhausted.

**Blocked by:** [10 - Preserve uploaded outputs across ambiguous completion](10-commit-safe-delivery.md), [11 - Retry transient siblings and repair manual export admission](11-retry-lineage.md)

**Status:** ready-for-agent

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
- `apps/worker/src/tasks/auto-layout-analysis.ts`
- `apps/worker/src/tasks/auto-layout-analysis.test.ts`
- `packages/services/src/layout-evidence.ts`
- `packages/services/src/layout-evidence.test.ts`
- `apps/worker/src/__fixtures__/render-golden/expected/12-analysis-retry.json`

## Implementation

1. Propagate typed infrastructure failures through extraction and detectors instead of returning null. Distinguish content absence from process/storage failure.
2. Implement the spec's bounded analysis substep: at most three operations per group execution with cancellable 1s/2s delays, rebuilding failed segment/detector promises. This budget is independent of parent claims spent on unrelated work. Only exhaustion uses flagged center crop; process-start/configuration failure exits to executor recovery. Background retries use their existing durable schedule, never durable failed evidence.
3. Persist only valid content outcomes; reset existing local/dev infrastructure-failure evidence through a targeted operation recorded here, without querying or mutating shared development data as a test.
4. Keep permanent invalid source and ownership cancellation out of degradation. Record framing_degraded, attempts and causal code for terminal fallback; successful final-attempt evidence wins.

## Acceptance

- [ ] Transient extraction and detector failures retry without output/failure-envelope persistence, then success produces the original expected crop. No failed promise is reused as a retry.
- [ ] After exactly three transient analysis operations, automatic/screen/split exhaustion uses explicit center crop and a visible notice, never a cached transient failure. A first analysis on the last parent claim still gets its full substep budget.
- [ ] No-trustworthy-faces is cacheable content evidence; malformed source and lost ownership retain their typed outcomes.
- [ ] Normal successful analysis references remain exact. Existing transient cached envelopes are cleared rather than accepted through a compatibility parser.

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

Pending. Record commit/image hashes, commands, fixture reports and any unresolved acceptance here.

## Comments
