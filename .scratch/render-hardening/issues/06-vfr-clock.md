# 06 - Normalize affected VFR clocks to sane CFR

**What to build:** Prevent raw base rates from generating extreme frame counts and give VFR exports one rational presentation clock.

**Blocked by:** [05 - Limit proven clipping mixes without retuning normal audio](05-mix-clipping.md)

**Status:** done

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

- [x] No graph schedules 90000 generated frames per second from a VFR base rate.
- [x] Real VFR output has the selected rational CFR, full duration and synchronized audio.
- [x] 23.976/29.97 and normal CFR fixtures retain exact args/frames/audio.
- [x] Clock decision and input average/base/variability facts appear in diagnostics.

## Verification

Run from repository root. The command interface below is delivered by ticket 01 where applicable. Run media checks inside the pinned image. Record output/evidence rather than merely listing commands.

```sh
bun test apps/worker/src/composition-vfr.test.ts apps/worker/src/worker-process.test.ts
```

Run the full normal exact golden comparison from spec.md. For an approved defect ticket, also run its declared corrected expectations; preserve all unrelated baseline results.

`bun run lint` and `bun run typecheck` must pass for the assembled change. Capture scoped failures caused by unrelated in-flight work before changing any unowned file.

DB checks, when listed, must use `bash .scratch/api-extraction/db-gate.sh ...`; never run gates against shared Neon. No shared resource mutations or deployments are authorized by this ticket.

## Evidence

Base commit e8c93d1b32 plus this ticket's uncommitted paths (worker-process.ts, composition-ffmpeg-adapter.ts, composition-vfr.test.ts, expected/06-vfr-clock.json). Host FFmpeg 8.0.1, fingerprint 90cf30a30583bbe5. Evidence in /tmp/narriflow-golden/ticket-06/.

- Parity gate `bun apps/worker/scripts/render-golden.ts verify --baseline /tmp/narriflow-golden/baseline --suite all --out /tmp/narriflow-golden/candidate-06`: exit 0. Normal 18/18 identical (argv, frames, PCM, ffprobe; ntsc-24000-1001 and ntsc-30000-1001 included, no new expected-change). Known defects: 8 xfail unchanged, 0 unexpectedly passing, 10 corrected and passing (vfr-irregular activated, 6/6).
- vfr-irregular, before -> after (ffprobe): r_frame_rate 30/1 -> 15/1, avg_frame_rate 3150/179 -> 15/1, frames 105 -> 90 (plan 6 s x 15), video duration 5.933 -> 6.000, audio 6.000, both streams start 0.000.
- `bun test` (apps/worker): 855 pass, 0 fail. `bun test composition-vfr.test.ts worker-process.test.ts`: 90 pass. Worker typecheck clean. Biome clean on the four paths.
- Real alternating 2/30 fps media (generated in composition-vfr.test.ts), uncut and across a cut: output r/avg_frame_rate equal the chosen rational, frames within 1 of duration x rate, duration within one frame, audio duration within 50 ms, A/V start within one frame.

Design: `inspectMedia` reads at most 300 packet timestamps (one extra ffprobe) only when r_frame_rate and avg_frame_rate are both known and differ by more than 1%; matching rates (all normal fixtures, NTSC) cost nothing and add no field. A source is affected when timestamps are variable (more than 5% of intervals off the median by over 20%) or the base rate exceeds 240 fps. Rate is the measured average snapped (orchestrator decision) to the smallest standard rate not below it within 1% from {15, 24000/1001, 24, 25, 30000/1001, 30, 50, 60000/1001, 60}; an exact standard average is kept, above 60 is 60/1, below 15 is 15/1, unknown is 30/1. Re-gated to candidate-06b: exit 0, normal 18/18 identical, 10 corrected passing; `bun test` apps/worker 861 pass. `inspection.fps` and the new `inspection.videoClock` (base, average, variable, packetsSampled, constantRate, reason) carry the decision; an info log records it. The adapter inserts `fps=<rational>` on the source before any scene split (`start_time=0` on the cut clock, `setpts=PTS-STARTPTS` first otherwise) and uses the exact rational for generated scenes and backgrounds. Unreadable packet evidence never fails inspection.

## Comments

- Awkward averages now snap to standard rates (the ~17 fps alternating source picks 24000/1001, not 24/1, because the decided list orders 23.976 first; an exact 24 average is kept as 24/1).
- A real file with ffprobe r_frame_rate 90000/1 could not be generated with this FFmpeg (mp4, mkv, ts and avi all report sane base rates); the 90000/1 base with 15/1 average is covered at the inspection and graph boundary in composition-vfr.test.ts.
