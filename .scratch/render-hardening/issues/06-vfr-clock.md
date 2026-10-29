# 06 - Normalize affected VFR clocks to sane CFR

**What to build:** Prevent raw base rates from generating extreme frame counts and give VFR exports one rational presentation clock.

**Blocked by:** [05 - Limit proven clipping mixes without retuning normal audio](05-mix-clipping.md)

**Status:** ready-for-agent

**Suggested implementer:** Claude

**Contract:** [Render hardening spec](../spec.md). Read the relevant contract sections and AGENTS.md before claiming.

## File ownership

Exhaustive write set, relative to repository root. This ticket may also update its own issue file with status and evidence. All other paths are read-only. Shared paths are serialized by blocker ancestry. If an additional file is necessary, amend the write set and dependency edges before editing it.

- `apps/worker/src/worker-process.ts`
- `apps/worker/src/composition-ffmpeg-adapter.ts`
- `apps/worker/src/composition-vfr.test.ts`
- `apps/worker/src/__fixtures__/render-golden/expected/06-vfr-clock.json`

## Implementation

1. Adopt measured rational fps for generated scenes/backgrounds. Determine timestamp variability from bounded packet evidence, preserving exact standard fractions.
2. For affected VFR use the measured average in [1,60], else 30/1, and make affected branches CFR without moving real-time events or dialogue. Leave ordinary CFR branches and their argv untouched.
3. Cover the synthetic 90000/1 base and 15/1 average facts at the render-facing boundary, plus real alternating 2/30fps media.

## Acceptance

- [ ] No graph schedules 90000 generated frames per second from a VFR base rate.
- [ ] Real VFR output has the selected rational CFR, full duration and synchronized audio.
- [ ] 23.976/29.97 and normal CFR fixtures retain exact args/frames/audio.
- [ ] Clock decision and input average/base/variability facts appear in diagnostics.

## Verification

Run from repository root. The command interface below is delivered by ticket 01 where applicable. Run media checks inside the pinned image. Record output/evidence rather than merely listing commands.

```sh
bun test apps/worker/src/composition-vfr.test.ts apps/worker/src/worker-process.test.ts
```

Run the full normal exact golden comparison from spec.md. For an approved defect ticket, also run its declared corrected expectations; preserve all unrelated baseline results.

`bun run lint` and `bun run typecheck` must pass for the assembled change. Capture scoped failures caused by unrelated in-flight work before changing any unowned file.

DB checks, when listed, must use `bash .scratch/api-extraction/db-gate.sh ...`; never run gates against shared Neon. No shared resource mutations or deployments are authorized by this ticket.

## Evidence

Pending. Record commit/image hashes, commands, fixture reports and any unresolved acceptance here.

## Comments
