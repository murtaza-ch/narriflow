# 03 - Correct rotation and sample-aspect geometry

**What to build:** Use one display-oriented coordinate system for Studio, layout analysis, previews and exports, correcting only rotated/anamorphic/odd-SAR cases.

**Blocked by:** [02 - Normalize process starts and expose complete media facts](02-process-and-media-boundary.md)

**Status:** ready-for-agent

**Suggested implementer:** Claude

**Contract:** [Render hardening spec](../spec.md). Read the relevant contract sections and AGENTS.md before claiming.

## File ownership

Exhaustive write set, relative to repository root. This ticket may also update its own issue file with status and evidence. All other paths are read-only. Shared paths are serialized by blocker ancestry. If an additional file is necessary, amend the write set and dependency edges before editing it.

- `apps/worker/src/worker-process.ts`
- `apps/worker/src/composition-ffmpeg-adapter.ts`
- `apps/worker/src/tasks/clip-render-attempt.ts`
- `apps/worker/src/tasks/clip-render-attempt-runtime.ts`
- `apps/worker/src/tasks/clip-preview.ts`
- `apps/worker/src/tasks/auto-layout-analysis.ts`
- `apps/worker/src/layout-evidence-runtime.ts`
- `apps/worker/src/tasks/reframe.ts`
- `packages/composition-plan/src/clip-composition-plan.ts`
- `packages/composition-plan/src/display-geometry.ts`
- `packages/composition-plan/src/display-geometry.test.ts`
- `apps/worker/src/composition-display-geometry.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/video-preview.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/composition-preview-adapter.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/composition-preview-adapter.test.ts`
- `apps/worker/src/__fixtures__/render-golden/expected/03-display-geometry.json`

## Implementation

1. Adopt the inspection display transform in the shared planner and all media consumers listed. Match FFmpeg autorotation exactly once; transform detector/PiP coordinates and source dimensions together. Keep the new geometry helper internal to the composition package unless existing exports require a separately coordinated edit.
2. Calculate displayed aspect using SAR before existing center/fit/crop policy. Normalize output to square pixels only on paths whose existing output needs correction; keep ordinary identity-transform square-pixel args untouched.
3. Make the Studio consumer of the shared composition plan use corrected display dimensions and compatible durable evidence. Browser video dimensions are already display-oriented; avoid applying the matrix again to a decoded preview proxy. Keep crop math in the shared plan.

## Acceptance

- [ ] 90/180/270 and mirrored display matrices show the expected subject, with no crop clamping or invalid crop.
- [ ] Anamorphic 2:1 SAR and odd 321x181 sources retain correct displayed proportions and end at SAR 1:1.
- [ ] Fit/center/speaker/PiP and preview/export use the same transformed coordinates.
- [ ] Normal crops, argv, decoded frames and audio remain exact; corrected expectations affect only geometry-defect fixtures.

## Verification

Run from repository root. The command interface below is delivered by ticket 01 where applicable. Run media checks inside the pinned image. Record output/evidence rather than merely listing commands.

```sh
bun test packages/composition-plan/src/display-geometry.test.ts apps/worker/src/composition-display-geometry.test.ts apps/worker/src/tasks/clip-preview.test.ts apps/worker/src/tasks/auto-layout-analysis.test.ts
```

Run the full normal exact golden comparison from spec.md. For an approved defect ticket, also run its declared corrected expectations; preserve all unrelated baseline results.

`bun run lint` and `bun run typecheck` must pass for the assembled change. Capture scoped failures caused by unrelated in-flight work before changing any unowned file.

DB checks, when listed, must use `bash .scratch/api-extraction/db-gate.sh ...`; never run gates against shared Neon. No shared resource mutations or deployments are authorized by this ticket.

## Evidence

Pending. Record commit/image hashes, commands, fixture reports and any unresolved acceptance here.

## Comments
