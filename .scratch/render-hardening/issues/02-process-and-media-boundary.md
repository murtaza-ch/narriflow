# 02 - Normalize process starts and expose complete media facts

**What to build:** Give all callers one typed process-start failure and one bounded media inspection contract without changing normal media decisions.

**Blocked by:** [01 - Golden parity harness and pinned reference image](01-golden-parity-harness.md)

**Status:** done

**Suggested implementer:** Sol

**Contract:** [Render hardening spec](../spec.md). Read the relevant contract sections and AGENTS.md before claiming.

## File ownership

Exhaustive write set, relative to repository root. This ticket may also update its own issue file with status and evidence. All other paths are read-only. Shared paths are serialized by blocker ancestry. If an additional file is necessary, amend the write set and dependency edges before editing it.

- `apps/worker/src/worker-process.ts`
- `apps/worker/src/worker-process.test.ts`
- `packages/validators/src/source-probe.ts`
- `packages/validators/src/source-probe.test.ts`
- `apps/worker/scripts/render-golden.ts` (owner-approved amendment, 2026-10-29)
- `apps/worker/scripts/render-golden.test.ts` (same amendment)

## Implementation

1. Wrap synchronous spawn throws and asynchronous error events through the same classifier and diagnostics, for execute and persistent helper start. Preserve cancellation reasons and TERM/KILL ownership.
2. Expose safe errno, executable class and bounded diagnostics. Missing/forbidden executables are configuration-health failures, not permanent content defects. Provide enough typed information for the later executor quarantine ticket.
3. Extend the sole media parser with coded/display dimensions, matrix/reflection/SAR, average/base rational fps, stream clocks/starts/audio span, codecs/profile/pixel format/color, size and frame-count facts. Add bounded frame/packet inspection when requested for validation or timestamp diagnosis.
4. Keep existing width/height/fps consumer behavior until the geometry/clock tickets adopt new facts. Keep facts optional only where genuinely absent; update the persisted source validator for facts needed by later cache reuse. Avoid legacy raw-probe readers.

## Acceptance

- [x] Sync EBADF/EMFILE/EAGAIN and asynchronous spawn errors produce matching stable codes and diagnostics; pre-aborted starts spawn nothing.
- [x] Missing executable and startup timeout are distinguishable from source-media-invalid; failures preserve cause and never expose signed URLs.
- [x] Real and injected probes cover display matrices/reflection, SAR, 90000/1 base vs 15/1 average, late audio, cover art, HDR tags and absent nb_frames.
- [x] Normal golden argv, frames and PCM remain exact. No caller uses a second ffprobe parser.

## Verification

Run from repository root. The command interface below is delivered by ticket 01 where applicable. Run media checks inside the pinned image. Record output/evidence rather than merely listing commands.

```sh
bun test apps/worker/src/worker-process.test.ts packages/validators/src/source-probe.test.ts
```

Run the full normal exact golden comparison from spec.md. For an approved defect ticket, also run its declared corrected expectations; preserve all unrelated baseline results.

`bun run lint` and `bun run typecheck` must pass for the assembled change. Capture scoped failures caused by unrelated in-flight work before changing any unowned file.

DB checks, when listed, must use `bash .scratch/api-extraction/db-gate.sh ...`; never run gates against shared Neon. No shared resource mutations or deployments are authorized by this ticket.

## Evidence

Started at `dev` HEAD `a4c8c003cab5ec6194ec3b23caf8e7fec6c5de60`. The orchestrator independently committed ticket 11 during this work, advancing HEAD to `c124bb66eb1681b320993db60b437b17f0808494`; no commit was made by this implementer. All six implementation paths remain uncommitted. The final all-suite parity gate passed with exit 0 before close-out.

## Comments

Write-set amendment approved by the orchestrator/user on 2026-10-29: ticket 01 is closed and ticket 11 does not own the golden runner. Compare every field present in the baseline inspection recursively and exactly; allow additional candidate inspection fields, record them in captures, and verify their expectations in focused tests. Do not rewrite the baseline or change plan, argv/filtergraph, frame/PTS or PCM comparisons.


Implementation details
- `execute` and persistent `start` use the same synchronous/asynchronous spawn classifier. Failures preserve the original cause and carry safe `errno`, `executableClass`, `failureScope`, and bounded diagnostics. `worker_command_spawn_failed` is executor health; `worker_command_unavailable` is configuration health. Both are retryable on a healthy executor, so an unavailable executable does not reuse the old permanently classified `worker_command_missing` code. Helper readiness timeout remains `worker_process_startup_timeout` with executor scope. Pre-aborted requests never call spawn or injected execution. Helper starts without a readiness marker now wait for the spawn result. Existing cancellation reasons and process-group TERM/KILL ownership remain intact.
- Stderr is redacted before capture truncation, including signed query strings spanning multiple chunks. A regression test writes a 120,000-character query through both process paths; neither diagnostics nor messages expose its signature.
- Real inspections always return `facts`, and the same object is persisted as `sourceProbe.facts` when duration is available. `MediaFacts`/`mediaFactsSchema` expose container size/start/duration, every playable video/audio stream, attached-picture count, coded/sample/display dimensions, raw matrix and reflection, SAR, both rational rates, stream clocks/starts/ends, frame counts, codec/profile/pixel format/color, HDR/Dolby Vision metadata, and audio rate/channels/padding. Null denotes an unreported fact. Minimal timeline-only probe inputs remain valid but are not complete cache evidence. No consumer of the old width/height/fps fields changes, and no additional raw ffprobe parser was introduced.
- Optional `sample: { kind: "frames" | "packets", streamIndex, startSec?, maxPackets }` uses a selected-stream `-read_intervals` packet budget, capped at 4096 packets and 4 MiB stdout, within the original inspection deadline. Results contain typed timestamps, durations, keyframe/sample/size facts. A bounded sample is explicitly not proof of a complete decode.
- Compared FFmpeg's existing matrix representation and probe interval support before implementation: [display.h](https://github.com/FFmpeg/FFmpeg/blob/n7.1/libavutil/display.h), [display.c](https://github.com/FFmpeg/FFmpeg/blob/n7.1/libavutil/display.c), [ffprobe documentation](https://github.com/FFmpeg/FFmpeg/blob/n7.1/doc/ffprobe.texi). Kept FFmpeg as the probe/decoder and implemented only typed fact extraction. No dependency was added.

Verification
- `bun test apps/worker/src/worker-process.test.ts packages/validators/src/source-probe.test.ts`: **86 pass, 0 fail**. Includes sync/async EBADF/EMFILE/ENFILE/EAGAIN/ENOENT/EACCES/EPERM for execution and helper starts, real missing/forbidden executables, readiness timeout, cancellation, long signed-query redaction, real rotation/reflection/SAR/PQ/HLG/late-audio/cover-art probes, bounded frame/packet reads, injected 90000/1 base vs 15/1 average and absent frame counts. Log `/tmp/ticket02-focused.log`.
- `cd apps/worker && bun test`: **777 pass, 0 fail**, 42 files, 4286 assertions. Log `/tmp/ticket02-worker-tests.log`. Includes the 26 golden runner tests; the explicit `bun test apps/worker/scripts/render-golden.test.ts` run also passed 26/26.
- `cd packages/validators && bun test`: **621 pass, 0 fail**. Log `/tmp/ticket02-validators-tests.log`.
- `bun run --cwd apps/worker typecheck` and `bun run --cwd packages/validators typecheck`: **pass**. The golden script, outside the worker tsconfig, also passes `bunx tsc -p /tmp/ticket02-scripts-tsconfig.json --noEmit` using a temporary config extending the worker config and including `scripts/render-golden.ts`.
- `bunx biome check` on all six owned TypeScript paths: **pass**, no warnings. `git diff --check` on all owned paths: **pass**. Root `bun run lint`: **exit 0**, existing 11 warnings and 1 info. Root `bun run typecheck`: **exit 0**, 15 successful tasks. Logs `/tmp/ticket02-biome.log`, `/tmp/ticket02-repo-lint.log`, `/tmp/ticket02-repo-typecheck.log`.
- Baseline directory remains byte-identical to the durable copy, verified with `diff -qr /tmp/narriflow-golden/baseline ~/.cache/narriflow-render-golden/baseline-5680477046-90cf30a3`.

Integration notes
- Tickets 03/04/06/07/09 should consume typed `facts`/`samples`; ticket 13 must require complete `facts` for cache reuse. Tickets 14/17 should use `failureScope` for executor/configuration quarantine and must not treat `worker_command_unavailable` as a content defect. No unowned file change was needed to complete this ticket.
- The parity rule about extracting `clip-render-attempt.ts` compiler-input derivation does not activate here: that file and its input-assembly code were not changed.
- Same-host golden verification follows ticket 01's approved environment adaptation. No container runtime is available; Linux image/build/deployed fingerprint verification remains ticket 21. No shared DB gates, application startups, shared-resource mutations, or deployments were needed. Existing live worker/API/web processes and ticket 11's files were left alone.


Final parity gate
```sh
bun apps/worker/scripts/render-golden.ts verify --baseline /tmp/narriflow-golden/baseline --suite all --out /tmp/narriflow-golden/candidate-02
```
**PASS, exit 0**, after the final production edit. Normal **18/18 identical** in plan/crops/cues/layers, existing inspection fields, ASS, argv/filtergraph bytes, decoded video frames/PTS and audio PCM. All **18 known-defect references unchanged**, with no unexpected passes or behavior changes. No corrected expectations were needed. Report `/tmp/narriflow-golden/candidate-02/report.md` and `report.json`; log `/tmp/narriflow-golden/verify-02.log`.

Baseline commit `5680477046a7972435a728c7ce3d0b9b9513fe4f`; candidate HEAD `c124bb66eb1681b320993db60b437b17f0808494` plus this ticket's edits. Unchanged runtime fingerprint `90cf30a30583bbe50e3972558024cc2ce7b9bffe683b79411d839e93d0d05f7f`, fixture toolchain `61eaae45762c8f89`, host macOS arm64 / Bun 1.4.2 / FFmpeg 8.0.1. The frozen baseline was neither rewritten nor refreshed. The approved harness change only permits candidate object fields absent from the baseline inspection; every recorded baseline field, including nested objects, array lengths/items, nulls and missing-field checks, remains exact. Added fields automatically become exact when present in a future independent capture. Tests prove additive facts pass, old width/duration changes or removed fps fail, and a changed fact already present in a new capture fails. All other comparison code is untouched.
