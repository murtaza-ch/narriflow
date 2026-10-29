# 07 - Tone-map HDR before composing SDR layers

**What to build:** Export correctly converted and tagged BT.709 SDR for HDR sources without changing normal SDR output.

**Blocked by:** [06 - Normalize affected VFR clocks to sane CFR](06-vfr-clock.md)

**Status:** ready-for-agent

**Suggested implementer:** Claude

**Contract:** [Render hardening spec](../spec.md). Read the relevant contract sections and AGENTS.md before claiming.

## File ownership

Exhaustive write set, relative to repository root. This ticket may also update its own issue file with status and evidence. All other paths are read-only. Shared paths are serialized by blocker ancestry. If an additional file is necessary, amend the write set and dependency edges before editing it.

- `apps/worker/src/composition-ffmpeg-adapter.ts`
- `apps/worker/src/composition-hdr.test.ts`
- `apps/worker/src/__fixtures__/render-golden/expected/07-hdr-to-sdr.json`

## Implementation

1. Use source primaries/transfer/range/mastering facts to linearize, tone-map, convert to limited-range BT.709 and remove stale HDR metadata before SDR overlays.
2. Use the pinned zscale/tonemap CPU path described in the spec, including Hable parameters and peak assumptions in expected results. Correct HDR optional video layers too.
3. Handle supported Dolby Vision base layers explicitly and reject unsupported enhancement-only content with a typed code. Keep SDR filter paths and tags unchanged.

## Acceptance

- [ ] PQ and HLG reference patches demonstrate actual conversion, highlight rolloff and correct SDR overlay luminance; changing tags alone fails tests.
- [ ] Output is H.264 yuv420p with BT.709 primaries/transfer/matrix/range and no stale PQ/HLG mastering side data.
- [ ] Missing required HDR filter is a deployment-health failure, not silent relabeling.
- [ ] Normal SDR golden args, decoded frames, audio and color tags remain exact.

## Verification

Run from repository root. The command interface below is delivered by ticket 01 where applicable. Run media checks inside the pinned image. Record output/evidence rather than merely listing commands.

```sh
bun test apps/worker/src/composition-hdr.test.ts apps/worker/src/composition-ffmpeg-adapter.test.ts
```

Run the full normal exact golden comparison from spec.md. For an approved defect ticket, also run its declared corrected expectations; preserve all unrelated baseline results.

`bun run lint` and `bun run typecheck` must pass for the assembled change. Capture scoped failures caused by unrelated in-flight work before changing any unowned file.

DB checks, when listed, must use `bash .scratch/api-extraction/db-gate.sh ...`; never run gates against shared Neon. No shared resource mutations or deployments are authorized by this ticket.

## Evidence

Pending. Record commit/image hashes, commands, fixture reports and any unresolved acceptance here.

## Comments
