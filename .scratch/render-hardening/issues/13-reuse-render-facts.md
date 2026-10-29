# 13 - Reuse compatible layout and immutable media facts

**What to build:** Avoid rerunning layout analysis and media/font validation when exact compatible facts are already available.

**Blocked by:** [12 - Retry transient layout analysis before center fallback](12-analysis-retry.md)

**Status:** done

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
- `packages/validators/src/clip-auto-layout-analysis.ts` (amended: optional `analysisPath` provenance)
- `apps/worker/src/tasks/clip-render-attempt-core-paths.test.ts` (amended: one `layoutEvidence` adapter override so the harness never reads the database)

## Implementation

1. Re-read compatible durable evidence immediately before group planning without rereading mutable editor/entitlement state. Freeze the chosen evidence for the group.
2. Bind reuse to immutable source version, window/cuts/revision/preview/model/settings. Defer background analysis already covered by live render ownership. Keep source/proxy analysis separate if identical-plan tests do not establish interchangeability.
3. Cache complete source probe, selected-window asset validation and font bytes by immutable fingerprint/toolchain; existing Project.sourceProbe alone is insufficient. Refresh signed access locations independently.
4. Measure the duplicated detector work Claude found, with paired baseline/current samples, avoiding an unsupported promise that every clip gains 30–45%.

## Acceptance

- [x] Evidence arriving after parent snapshot but before group plan causes zero redundant detector execution when its full fingerprint matches.
- [x] Changed source/revision/cuts/preview/model/settings forces appropriate analysis; stale facts cannot change the plan.
- [x] Source/proxy comparison either proves exact plan equality or reuse remains constrained to the same path.
- [x] Cache hit/miss/deferred counts and analysis wall time appear in the report; no crop/cue/layer/argv/frame/PCM change in normal references.

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

Host: macOS arm64, Bun 1.4.2 / FFmpeg 8.0.1 (the ticket-01 host adaptation; no Linux image). Uncommitted at time of writing.

**What shipped**
- `LayoutEvidenceLifecycle.readCompatibleDurable(clipId, {editorRevision, previewStorageKey})` reads only the three evidence columns, bound to the frozen revision and preview. `renderClipGroup` calls it once, immediately before building the group's `LayoutEvidence`, only when the snapshot lacks some evidence and the clip has a preview; the evidence is then frozen inside that owner. A refresh failure or timeout logs `layout_evidence_refresh_failed` and costs only the saved analysis.
- `selectDurableLayoutEvidence` (exported beside `deriveRenderCompositionEvidence`): snapshot evidence always wins; late Screen/Split evidence fills gaps; late Automatic evidence is adopted only when its new optional `analysisPath` is `"source"`. The render persists `"source"`, the background loop persists `"proxy"`. Content compatibility (source identity, window, deleted ranges, size, engine/fingerprint) stays with `LayoutEvidence`, and infrastructure failure envelopes are still ignored.
- `render-fact-cache.ts` (process lifetime, positive facts only): font bytes by SHA-256 fingerprint (32 MiB LRU, used by `resolveRenderBrandFonts`), optional-media decode validation by content SHA-256 and kind (`validateMediaOnce`, wraps the runtime `validateOptionalMedia`), ranged source probe by `sourceStorageKey#sourceSizeBytes` (new `sourceSizeBytes` in the frozen snapshot; presigned URLs are always fresh; unknown size never caches). `clip_composition_resources` now logs `evidenceReadMs`, `evidenceReused`, `renderFactCache` hit/miss counts.

**Source vs proxy evidence is NOT interchangeable.** `/tmp/exp13/proxy-vs-source.ts` ran the real detectors and `LayoutEvidence` on `/tmp/narriflow-comparison-source.mp4` (1080p two-person podcast), 5 windows of 35-45 s: the production source extraction (`scale=-2:360`, ultrafast) vs the production preview proxy (540p, veryfast, +/-4 s padding) gave **0 of 5 identical analyses** (same segment counts, but crop centres differ up to about 0.002 and zoom up to 0.04, so crop rectangles and argv differ). Per the spec, reuse stays on the same path: a render never adopts proxy evidence that appears after its snapshot. Evidence already in the snapshot is used exactly as before (that pre-existing race is unchanged). The 30-45% estimate therefore cannot come from background evidence.

**Fresh vs reused is byte-identical.** `render-evidence-reuse.test.ts` renders one clip through the real attempt, planner and compiler (real argv) once analyzing and once reading the evidence the first stored through JSON: identical argv, `planFingerprint` and `commandBytes`, zero extraction/detector/scene executions, `evidenceReused: ["automatic"]`. Negative cases render fresh and equal the baseline argv: proxy or provenance-less evidence, changed window, end, source identity, deleted ranges, source size; refresh failure; other editor revision (the read is bound to it); infrastructure failure envelope. A mutation (accepting any provenance) fails two tests.

**Measurement** (`/tmp/exp13/measure.ts`; real FFmpeg, real Python detectors, real `ClipRenderAttempt`, ranged reads from a local Range server; 4 clips of 25 s from the source above, each rendered as a "latest" group and a frozen export group = 8 groups, 1080p 9:16, 3 paired alternating runs, fresh fact cache per run; "baseline" = refresh answers nothing newer = pre-ticket behavior):

| | baseline | reuse |
|---|---|---|
| attempt wall | 87.6 / 89.7 / 89.7 s (mean 89.0) | 78.5 / 80.9 / 82.2 s (mean 80.5) |
| analyses / detector runs / extracted segments | 8 / 16 / 8 | 4 / 8 / 4 (4 groups reused) |
| extraction ffmpeg | 9.6-10.1 s | 4.8-5.6 s |
| face detector (python) | 6.4-6.7 s | 3.4-3.5 s |
| scene-cut ffmpeg | 9.1-9.7 s | 4.6-5.0 s |
| encode ffmpeg | 66.6-68.2 s | 67.1-69.4 s |
| evidence read | n/a | 0-1 ms |

Reuse saved about 8.5 s of 89 s (9.6%, every pair positive): analysis is roughly 19 s of the baseline wall (extraction plus the longer of the two concurrent detectors, about 2.4 s per group) and encode is 75%. This workload's gain is bounded by two groups per clip; clips that are analyzed once gain nothing, so the 30-45% claim is unsupported here. Source probe: first attempt 74 ms, second attempt of the same source 0 ms (hit); font/validation caches were not exercised by this workload (no brand fonts/music) and are covered by unit tests only. Raw: `/tmp/exp13/measure2.log`.

**Verification**
- `bun test` in `apps/worker`: 994 pass, 0 fail (log in the session; includes 12 new reuse tests and 9 fact-cache tests). `bun test packages/services/src/layout-evidence.test.ts`: 6 pass, 1 opt-in DB test skipped.
- Typechecks (`apps/worker`, `packages/services`, `packages/composition-plan`, `packages/validators`): clean. `bunx biome check` on all owned paths: clean.
- Parity gate `bun apps/worker/scripts/render-golden.ts verify --baseline /tmp/narriflow-golden/baseline --suite all --out /tmp/narriflow-golden/candidate-13`: **exit 0** (`/tmp/narriflow-golden/verify-13.log`). The runner already derives the planner's evidence through `deriveRenderCompositionEvidence` from frozen availability; this ticket changes only the durable inputs upstream of `LayoutEvidence` (`selectDurableLayoutEvidence`), so no runner change was needed and the baseline was not touched.
- `bash .scratch/api-extraction/db-gate.sh bun run test:workflow:db`: exit 0, 184 tests across 7 files, 0 fail (`/tmp/narriflow-golden/ticket13-workflow-db.log`).

## Comments

- Deviations: (1) Background analysis is not deferred behind live render ownership: no per-clip live ownership exists before the render-group lease (tickets 19/20) and the spec table assigns "avoid competing analysis" to ticket 17, so deferred count is always 0 here. (2) Source identity is write-once key + byte size from the frozen snapshot, not an ETag HEAD: ingest keys are unique per upload (`upload/<sessionId>`, `link/<timestamp>-...`), and a HEAD would put a network call into every test harness. (3) Existing rows written without `analysisPath` are treated as not render-reusable when they arrive late (the snapshot path is unchanged); no legacy parser.
- Finding for another owner (not changed here): rendering real 1080p60 podcast footage on this host fails output validation with `output_colorTransfer_mismatch, output_colorPrimaries_mismatch` for 3 of 4 windows (colour tags of the source/encode vs the plan's bt709 expectation), in baseline and reuse alike. The golden fixtures pass, so ticket 07/09 should check sources with untagged or non-bt709 colour. It did not affect the timings (the failure is after encode).
