# 05 - Limit proven clipping mixes without retuning normal audio

**What to build:** Correct clipped music/SFX/scene mixes while leaving ordinary gain, loudness and PCM unchanged.

**Blocked by:** [04 - Preserve late and short dialogue on the edited clock](04-audio-clock.md)

**Status:** ready-for-agent

**Suggested implementer:** Claude

**Contract:** [Render hardening spec](../spec.md). Read the relevant contract sections and AGENTS.md before claiming.

## File ownership

Exhaustive write set, relative to repository root. This ticket may also update its own issue file with status and evidence. All other paths are read-only. Shared paths are serialized by blocker ancestry. If an additional file is necessary, amend the write set and dependency edges before editing it.

- `apps/worker/src/composition-ffmpeg-adapter.ts`
- `apps/worker/src/tasks/clip-render-attempt.ts`
- `apps/worker/src/render-mix-peak.ts`
- `apps/worker/src/render-mix-peak.test.ts`
- `apps/worker/src/composition-mix-limiter.test.ts`
- `apps/worker/src/__fixtures__/render-golden/expected/05-mix-clipping.json`

## Implementation

1. Measure decoded candidate peaks through Worker Process Module, before upload, for mixes that can clip. Return a typed peak result usable by the later output validator.
2. Only a proven >0 dBFS mix triggers one corrective encode of the frozen composition using a 0.95 limiter with auto-level disabled. Compensate limiter latency and validate decoded sample/true peaks. Bound the correction to one pass.
3. Preserve non-clipping args and PCM, existing explicit gains and existing censor handling. No global LUFS, sample-rate, channel or volume policy change.

## Acceptance

- [ ] Hot source+music, multiple SFX and scene audio fixtures finish with decoded sample/true peak <=0 dBFS and unchanged dialogue onset.
- [ ] A normal non-clipping mix issues its original encode args and retains exact PCM; no limiter is added opportunistically.
- [ ] A still-invalid corrected mix fails with a typed error and never uploads.
- [ ] The future output validator can consume the peak facts rather than running an independent unbounded probe.

## Verification

Run from repository root. The command interface below is delivered by ticket 01 where applicable. Run media checks inside the pinned image. Record output/evidence rather than merely listing commands.

```sh
bun test apps/worker/src/render-mix-peak.test.ts apps/worker/src/composition-mix-limiter.test.ts
```

Run the full normal exact golden comparison from spec.md. For an approved defect ticket, also run its declared corrected expectations; preserve all unrelated baseline results.

`bun run lint` and `bun run typecheck` must pass for the assembled change. Capture scoped failures caused by unrelated in-flight work before changing any unowned file.

DB checks, when listed, must use `bash .scratch/api-extraction/db-gate.sh ...`; never run gates against shared Neon. No shared resource mutations or deployments are authorized by this ticket.

## Evidence

Pending. Record commit/image hashes, commands, fixture reports and any unresolved acceptance here.

## Comments
