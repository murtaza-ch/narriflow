# 04 - Preserve late and short dialogue on the edited clock

**What to build:** Keep full planned video and correct dialogue timing when audio starts late, ends early or has timestamp gaps.

**Blocked by:** [03 - Correct rotation and sample-aspect geometry](03-display-geometry.md)

**Status:** ready-for-agent

**Suggested implementer:** Claude

**Contract:** [Render hardening spec](../spec.md). Read the relevant contract sections and AGENTS.md before claiming.

## File ownership

Exhaustive write set, relative to repository root. This ticket may also update its own issue file with status and evidence. All other paths are read-only. Shared paths are serialized by blocker ancestry. If an additional file is necessary, amend the write set and dependency edges before editing it.

- `apps/worker/src/composition-ffmpeg-adapter.ts`
- `apps/worker/src/tasks/clip-render-attempt.ts`
- `apps/worker/src/composition-scene-audio.test.ts`
- `apps/worker/src/composition-audio-clock.test.ts`
- `apps/worker/src/__fixtures__/render-golden/expected/04-audio-clock.json`

## Implementation

1. Carry the inspected source A/V clock into audio assembly and preserve offsets through seek, cuts and inserted scenes. Pad missing audio before trim; planned edited video length is authoritative.
2. Use a narrow timing/coverage predicate for affected input branches. A full-length aligned ordinary track must retain the old compiler args and PCM. Do not globally add resampling or erase leading silence with independent PTS reset.
3. Test no-audio video, early/late/short/gapped/negative-start audio and combinations with scene audio/music/SFX. Update misleading comments that claim dialogue is always long enough.

## Acceptance

- [ ] The 3s-video/0.5s-audio plus music fixture produces the full 3s video and planned frames.
- [ ] The 0.976s late-audio fixture retains dialogue onset within one frame and full video duration.
- [ ] Cut and inserted-scene versions stay synchronized; no-audio behavior remains intentional.
- [ ] Normal references retain exact argv, video frames and PCM; only audio-clock defect expectations change.

## Verification

Run from repository root. The command interface below is delivered by ticket 01 where applicable. Run media checks inside the pinned image. Record output/evidence rather than merely listing commands.

```sh
bun test apps/worker/src/composition-audio-clock.test.ts apps/worker/src/composition-scene-audio.test.ts apps/worker/src/composition-ffmpeg-adapter.test.ts
```

Run the full normal exact golden comparison from spec.md. For an approved defect ticket, also run its declared corrected expectations; preserve all unrelated baseline results.

`bun run lint` and `bun run typecheck` must pass for the assembled change. Capture scoped failures caused by unrelated in-flight work before changing any unowned file.

DB checks, when listed, must use `bash .scratch/api-extraction/db-gate.sh ...`; never run gates against shared Neon. No shared resource mutations or deployments are authorized by this ticket.

## Evidence

Pending. Record commit/image hashes, commands, fixture reports and any unresolved acceptance here.

## Comments
