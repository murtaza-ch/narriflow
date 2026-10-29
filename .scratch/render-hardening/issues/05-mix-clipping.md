# 05 - Limit proven clipping mixes without retuning normal audio

**What to build:** Correct clipped music/SFX/scene mixes while leaving ordinary gain, loudness and PCM unchanged.

**Blocked by:** [04 - Preserve late and short dialogue on the edited clock](04-audio-clock.md)

**Status:** done

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
- `apps/worker/scripts/render-golden.ts` (amendment: the runner calls the same `guardMixPeak` as the worker, so the gate exercises the real correction rather than mirroring it)
- `apps/worker/src/tasks/clip-render-attempt-core-paths.test.ts` (amendment: its fake ffmpeg must answer the new peak measurement, plus three attempt-level guard tests)

## Implementation

1. Measure decoded candidate peaks through Worker Process Module, before upload, for mixes that can clip. Return a typed peak result usable by the later output validator.
2. Only a proven >0 dBFS mix triggers one corrective encode of the frozen composition using a 0.95 limiter with auto-level disabled. Compensate limiter latency and validate decoded sample/true peaks. Bound the correction to one pass.
3. Preserve non-clipping args and PCM, existing explicit gains and existing censor handling. No global LUFS, sample-rate, channel or volume policy change.

## Acceptance

- [x] Hot source+music, multiple SFX and scene audio fixtures finish with decoded sample/true peak <=0 dBFS and unchanged dialogue onset.
- [x] A normal non-clipping mix issues its original encode args and retains exact PCM; no limiter is added opportunistically.
- [x] A still-invalid corrected mix fails with a typed error and never uploads.
- [x] The future output validator can consume the peak facts rather than running an independent unbounded probe.

## Verification

Run from repository root. The command interface below is delivered by ticket 01 where applicable. Run media checks inside the pinned image. Record output/evidence rather than merely listing commands.

```sh
bun test apps/worker/src/render-mix-peak.test.ts apps/worker/src/composition-mix-limiter.test.ts
```

Run the full normal exact golden comparison from spec.md. For an approved defect ticket, also run its declared corrected expectations; preserve all unrelated baseline results.

`bun run lint` and `bun run typecheck` must pass for the assembled change. Capture scoped failures caused by unrelated in-flight work before changing any unowned file.

DB checks, when listed, must use `bash .scratch/api-extraction/db-gate.sh ...`; never run gates against shared Neon. No shared resource mutations or deployments are authorized by this ticket.

## Evidence

Base HEAD 61780fe1 plus uncommitted edits. Host-only golden gate (see ticket 01). Artifacts in `/tmp/narriflow-golden/ticket-05/` (`peaks-before-after.json`, `onset-lag.json`, `verify-05.log`, `report.md`).

**Design.** `render-mix-peak.ts` owns the policy: `mixCanClip` (music or SFX present), `parseMixPeakMetadata`, and `guardMixPeak`. After a successful encode of such a mix, one `ffmpeg` decode of the output's first audio stream (`astats` sample peak + `ebur128` true peak, printed with `ametadata` on stdout, `-xerror`, validation-budget deadline) runs through the Worker Process Module. Only a decoded sample peak or true peak above 1.0 (0 dBFS) triggers the single corrective encode: the same compiled command with `limitMixPeaks: true`, which appends `apad=pad_dur=0.005,alimiter=limit=0.950:level=disabled,atrim=start=0.004972,asetpts=PTS-STARTPTS` after `amix` (`alimiter` delays by `floor(rate*0.005)-1` samples; the pad and trim restore dialogue onset and length exactly at 32/44.1/48 kHz, one sample early below). The result is measured again; still above 1.0 throws `MixPeakError` (`render_output_invalid`, reason `mix_peak_exceeded`, permanent) before `scheduleUpload`. An unreadable measurement is `mix_peak_unmeasurable` (retryable); spawn/unavailable failures propagate untouched as executor health. A mix whose compiled limited command equals the original (censor beeps already carry a limiter) is not re-encoded. The returned `MixPeakResult` (`within_full_scale` | `limited` with initial and final facts) is logged as `clip_render_mix_peak` and is what ticket 09's validator can reuse. Normal mixes keep their exact original args: the only change to compile output is gated on `limitMixPeaks`.

**Parity-glue rule.** The runner's encode loop now calls the same `guardMixPeak` and compiles through the same `compileClipCompositionCommand` (`compile(limitMixPeaks)`), so the gate runs the real correction. No derivation of compiler inputs in `clip-render-attempt.ts` changed (only an extra compile closure), so no extraction was needed.

**Gate.** `bun apps/worker/scripts/render-golden.ts verify --baseline /tmp/narriflow-golden/baseline --suite all --out /tmp/narriflow-golden/candidate-05`: PASS, exit 0. Normal 18/18 identical (plan, crops, cues, layers, argv/graph, frames+PTS, PCM, ffprobe, loudness, decode). Known defects: 9 corrected and passing (rot90, rot270, rot90-mirror, sar-2x1, odd-321x181, audio-late-start, audio-short, audio-late-cut-scene-music, hot-mix); the rot180 and mirror-h guards still pass and the other 7 defects (vfr-irregular, hdr-pq, hdr-hlg, emoji-sequences, missing-glyph, seek-past-source-end, http-interrupted-read) are unchanged expected failures (the report's "9 unchanged" counts the 2 guards); 0 xpass, 0 changed. Frames/PCM changes in normal cases: 0. Of the three cases with a music/SFX mix, `logo-broll-music-sfx-censor` and `audio-late-cut-scene-music` measure `within_full_scale` and take no second encode; `logo-broll-music-sfx-censor` PCM is bit-identical to the baseline.

**True peak before/after (hot-mix, `expected/05-mix-clipping.json`)**: sample peak 2.208 -> 0.9945, true peak +6.9 dBTP -> -0.04 dBTP (0.995 linear), integrated -1.5 -> -1.4 LUFS. Decoded video frames/PTS identical to baseline; argv of the first pass identical; PCM length 192512 -> 192512 samples; sign-pattern cross-correlation of baseline vs candidate at the 1.0 s burst, the 3.0 s burst and 0.4 s is best at lag 0 samples.

**Tests.** `bun test` in `apps/worker`: 828 pass, 0 fail (46 files). `bun test apps/worker/src/render-mix-peak.test.ts apps/worker/src/composition-mix-limiter.test.ts`: 13 + 6 pass. `composition-mix-limiter.test.ts` renders real stereo AAC mixes: hot dialogue + hot music, three overlapping hot SFX, music + SFX together, inserted-scene audio over music + SFX; each first pass decodes above 1.0, the corrected output has decoded sample and true peak <= 1.0, the same sample count and frame count, and dialogue lag 0 samples; a late-SFX case proves the 0.6-1.8 s passage before the effects is bit-identical after correction; a normal mix keeps its exact args, never compiles the limited command, and its PCM is unchanged. `clip-render-attempt-core-paths.test.ts` (89 pass) adds attempt-level tests: a fitting mix has one encode, a clipping mix re-encodes once with only the limiter added then uploads, and a mix still hot after the pass fails `render_output_invalid` (permanent) and never uploads. Worker typecheck clean; the golden script and src type-check clean through a temporary tsconfig (`/tmp/ticket05-scripts-tsconfig.json`); `bunx biome check apps/worker/src apps/worker/scripts` clean. `render-golden.test.ts` 27 pass. Baseline still byte-identical to the durable copy.

## Comments

- AAC is lossy and the 0.95 limit leaves little headroom: the hot-mix result is 0.9945 sample / -0.04 dBTP. A mix that overshoots past 1.0 after the limiter pass fails permanently by design (one pass only). If `mix_peak_exceeded` shows up in production, lower the limiter ceiling (one constant, `MIX_PEAK_LIMITER_FILTER`) rather than adding passes.
- The first pass is overwritten by the corrective pass at the same path (`-y`); the failure case leaves a hot file that is never uploaded.
- Dialogue-only renders and scene-only audio (no music or SFX) are not measured: nothing sums there, and explicit gains are capped at 1. Censor-beep mixes keep their existing limiter and its uncompensated 5 ms lookahead (existing behavior, unchanged).
- Deployed Linux FFmpeg (7.1.5) was not run; `alimiter` latency and `atrim` rounding were measured on the host's FFmpeg 8.0.1. Ticket 21 re-runs the gate in the image; if it differs, the compensated onset test fails first.

### Addendum: tiered limiter ceilings (coordinator, replaces the one-pass bound)

A mix still above 1.0 after the 0.95 limiter no longer fails: `guardMixPeak` escalates through `MIX_PEAK_CEILINGS` = 0.95, 0.89, 0.79, one re-encode and one measurement per tier (same frozen command, `mixPeakCeiling` on the compiler input, same pad/trim), stopping at the first that fits. Only after the 0.79 tier is still above 1.0 does it throw `render_output_invalid` (permanent) with initial and per-tier peaks in `facts` and the message. Normal mixes (<= 1.0) get no extra encode. The tier used is logged as `render_mix_peak_limited` (tier, ceiling, before, after). Beep mixes no longer skip the tier (the equal-args shortcut is gone). Tests: `render-mix-peak.test.ts` (forced first-tier overshoot uses tier 2; exhaustion fails with three attempts), `clip-render-attempt-core-paths.test.ts` (tier 2 uploads; exhaustion makes four commands, no upload, permanent). Gate: `/tmp/narriflow-golden/candidate-05b`, exit 0, log `/tmp/narriflow-golden/verify-05b.log`. `bun test` in apps/worker: 830 pass.
