# 04 - Preserve late and short dialogue on the edited clock

**What to build:** Keep full planned video and correct dialogue timing when audio starts late, ends early or has timestamp gaps.

**Blocked by:** [03 - Correct rotation and sample-aspect geometry](03-display-geometry.md)

**Status:** done

**Suggested implementer:** Claude

**Contract:** [Render hardening spec](../spec.md). Read the relevant contract sections and AGENTS.md before claiming.

## File ownership

Exhaustive write set, relative to repository root. This ticket may also update its own issue file with status and evidence. All other paths are read-only. Shared paths are serialized by blocker ancestry. If an additional file is necessary, amend the write set and dependency edges before editing it.

- `apps/worker/src/composition-ffmpeg-adapter.ts`
- `apps/worker/src/tasks/clip-render-attempt.ts`
- `apps/worker/src/composition-scene-audio.test.ts`
- `apps/worker/src/composition-audio-clock.test.ts`
- `apps/worker/src/__fixtures__/render-golden/expected/04-audio-clock.json`
- `apps/worker/scripts/render-golden.ts` and `apps/worker/scripts/render-golden.test.ts` (amendment: the new `frames` retain token)

## Implementation

1. Carry the inspected source A/V clock into audio assembly and preserve offsets through seek, cuts and inserted scenes. Pad missing audio before trim; planned edited video length is authoritative.
2. Use a narrow timing/coverage predicate for affected input branches. A full-length aligned ordinary track must retain the old compiler args and PCM. Do not globally add resampling or erase leading silence with independent PTS reset.
3. Test no-audio video, early/late/short/gapped/negative-start audio and combinations with scene audio/music/SFX. Update misleading comments that claim dialogue is always long enough.

## Acceptance

- [x] The 3s-video/0.5s-audio plus music fixture produces the full 3s video and planned frames.
- [x] The 0.976s late-audio fixture retains dialogue onset within one frame and full video duration.
- [x] Cut and inserted-scene versions stay synchronized; no-audio behavior remains intentional.
- [x] Normal references retain exact argv, video frames and PCM; only audio-clock defect expectations change.

## Verification

Run from repository root. The command interface below is delivered by ticket 01 where applicable. Run media checks inside the pinned image. Record output/evidence rather than merely listing commands.

```sh
bun test apps/worker/src/composition-audio-clock.test.ts apps/worker/src/composition-scene-audio.test.ts apps/worker/src/composition-ffmpeg-adapter.test.ts
```

Run the full normal exact golden comparison from spec.md. For an approved defect ticket, also run its declared corrected expectations; preserve all unrelated baseline results.

`bun run lint` and `bun run typecheck` must pass for the assembled change. Capture scoped failures caused by unrelated in-flight work before changing any unowned file.

DB checks, when listed, must use `bash .scratch/api-extraction/db-gate.sh ...`; never run gates against shared Neon. No shared resource mutations or deployments are authorized by this ticket.

## Evidence

Base HEAD 72093606 plus uncommitted edits. Host-only golden gate (see ticket 01).

- Fix: `alignSourceAudioClock` (composition-ffmpeg-adapter.ts) emits `[0:a:0]aresample=async=1:first_pts=0,apad=whole_dur=<window>` and every cut, scene, mix and dialogue stage reads that label. Predicate, from the inspected `facts` only: the first audio stream starts more than one video frame after the window start, or ends more than one video frame plus one AAC packet before the window end (container start is the origin, as FFmpeg's `-ss` uses it), and the video covers the window. No facts, no audio, or a window past the picture's end (ticket 09's source-end defect) change nothing. `clip-render-attempt.ts` needed no change: it already passes the full inspection (with `facts`) as `source`, so no glue extraction applied.
- Gate: `bun apps/worker/scripts/render-golden.ts verify --baseline /tmp/narriflow-golden/baseline --suite all --out /tmp/narriflow-golden/candidate-04` exit 0 (log `/tmp/narriflow-golden/verify-04.log`). Normal 18/18 identical (plan, argv/graph bytes, frames+PTS, PCM, ffprobe, loudness, decode). Corrected and passing: audio-late-start, audio-short, audio-late-cut-scene-music (`expected/04-audio-clock.json`: dialogue onset within 0.034s, span deficit <= 0.055s, frame delta 0, duration delta <= 1 frame; retains plan/crop/cue/layer/captions and decoded video frames+PTS). 10 other defects unchanged, 0 xpass, 0 changed. Frames/PCM changes in normal cases: 0.
- ffprobe before/after (`/tmp/narriflow-golden/ticket-04/ffprobe-evidence.json`): audio-late-start audio start 0.456 -> 0.000, duration 3.543 -> 4.000, avOffset 0.006 -> 0.010; audio-short audio duration 2.005 -> 4.000, deficit 1.995 -> 0; audio-late-cut-scene-music avOffset -0.47 -> 0.01. All three: video 4.000/4.000/4.600s, 120/120/137 frames, equal to plan, audio and video start at 0.
- Harness amendment: `retain` accepts `frames` (decoded video frames/PTS only) so a correction can change audio and prove the picture stayed identical; covered by a test in `render-golden.test.ts` (27 pass).
- Tests: `composition-audio-clock.test.ts` (13): predicate matrix (covering/within-tolerance/early/negative/offset-container/clip-after-late-start/no facts/no audio/past-picture) and real renders for late 0.976s dialogue (onset within a frame, 30 frames), late dialogue across a cut, 3s video + 0.5s audio + music (30 frames, 3s audio), late dialogue around an inserted scene, no-audio source. With the fix disabled 7 of them fail. `bun test` in apps/worker: 806 pass, 0 fail; the three ticket files 71 pass. Worker typecheck clean; biome clean on all touched paths.

## Comments

- Not covered: true container-level timestamp gaps (ticket 01 could not synthesize them) and a gap in an otherwise full-length track; the aligned branch's `async=1` fills gaps over 0.1s, but only sources flagged by start/end coverage get that branch. Inserted scene assets' own audio offsets and the audiogram path are unchanged. A later ticket with bounded packet sampling could extend the predicate.
- `composition-scene-audio.test.ts` needed no edit (its short-audio mode still passes); misleading comment in `buildAudioMixFilter` updated.


## Comments
