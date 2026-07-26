# Plan 016: Enforce Free-tier watermark + 720p export cap in the render pipeline

> **Executor instructions**: Follow step by step. Run every verification command
> and confirm the expected result before the next step. Touch only in-scope
> files. On any STOP condition, stop and report — do not improvise.
>
> **Drift check (run first)**: excerpts taken from disk on 2026-07-07
> (uncommitted working tree). If an excerpt doesn't match the live file, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (touches the FFmpeg output path for every render)
- **Depends on**: none (015 also edits render-clips.ts — do NOT run concurrently with 015)
- **Category**: bug / monetization
- **Planned at**: commit `05d273d` (working tree, 2026-07-07)

## Why this matters

The pricing page sells the Free plan as "processing minutes … with watermark
and 720p testing exports" (`apps/web/app/(marketing)/pricing/page.tsx:134-137`)
and lists "No watermark" as a paid feature (line 21). The product roadmap calls
watermark removal "the #1 proven conversion lever" (ROADMAP.md §5). But the
render pipeline contains **zero watermark logic and no tier-based resolution**
— `grep -rin watermark apps/worker/src packages/services/src packages/validators/src`
returns nothing, and all aspect-ratio configs are hardcoded 1080p+
(`packages/validators/src/clip.ts:54-104`). Free users currently get exactly
the same output as Pro users, which removes the main reason to upgrade. This
plan makes the promise true: **free-tier renders get a small corner watermark
and are downscaled to 720p-class resolution; all paid tiers (starter, creator,
pro) are untouched.**

## Current state

- Tiers: `packages/validators/src/pricing.ts` — `pricingTierSchema` =
  `["free","starter","creator","pro"]`; `resolvePricingTier(value)` safely maps
  a nullable string to a tier (defaults `"free"`). `User.pricingTier` is kept
  in sync by the Stripe webhook (`packages/services/src/billing.service.ts:235-244`).
- The render task: `apps/worker/src/tasks/render-clips.ts`, entry
  `processClipRenderingRun(run)`. The claimed workflow run includes the project
  (`run.project.sourceStorageKey` used at line 1406). `Project.userId` exists in
  the Prisma schema (`packages/db/prisma/schema.prisma`, model Project).
- There are MULTIPLE ffmpeg arg builders (simple crop/scale, reframe/sendcmd,
  b-roll overlay, audiogram) each assembling filter chains and an
  `outputPath` (`render-clips.ts` lines ~875-1370, multiple functions using
  `aspectRatioConfig.get(...)`). Injecting per-tier scaling + watermark into
  every builder would be high-regression-risk.
- **Chosen design (do it this way): a single post-process pass.** After a
  render output file completes (there is a single place where each output's
  file is stat'ed/uploaded — see `render-clips.ts:1375-1379`
  `const outputStat = await stat(params.output.outputPath)`), if the owner's
  tier is `"free"`, run ONE extra ffmpeg command that (a) downscales by 2/3
  (1080×1920→720×1280, 1920×1080→1280×720, 1080×1080→720×720, 1080×1350→720×900)
  and (b) draws a watermark, then replace the file. This composes with every
  render path (captions, reframe, b-roll, audiogram, logo) because it operates
  on the finished video.
- FFmpeg invocation helper: find the existing helper that spawns ffmpeg in
  render-clips.ts (grep `spawn` / `runFfmpeg` / `execFile`) and reuse it — do
  not add a new child-process wrapper.
- Fonts: preset fonts are bundled in the worker image (see Dockerfile / the
  font-resolution helper `resolveFontName` in render-clips.ts). For the
  watermark prefer `drawtext` with a bundled font file; if resolving a font
  file path is fragile, use drawtext's default font (worker image has
  fontconfig) — verify with the smoke test in the Test plan.
- Structured logging: local `log(level, message, ctx)` helper in
  render-clips.ts — use it (`render_watermark_applied`, `render_downscaled_720p`).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0, 10/10 |
| Tests | `bun run test` | all pass |
| Lint | `bunx @biomejs/biome check .` | exit 0 |
| FFmpeg present | `ffmpeg -version` | prints version (dev machine has it) |

## Scope

**In scope**:
- `apps/worker/src/tasks/render-clips.ts` — tier lookup + post-process pass.
- `apps/worker/src/tasks/render-clips.test.ts` (or a new sibling test file) —
  unit tests for the pure arg-builder helper.
- `packages/validators/src/pricing.ts` — ONLY if you add a tiny pure helper
  like `isWatermarkedTier(tier)` (optional; inline `tier === "free"` is fine).
- `packages/services/src/project.service.ts` — ONLY these two thread-through
  edits (added 2026-07-07 after a verified STOP: `userId` is not selected on
  the claimed run):
  1. `ClaimedWorkflowRun` interface (~lines 108-125): add `"userId"` to the
     `Pick<Project, ...>` union for the `project` field.
  2. `claimNextWorkflowRun`'s Prisma `select` (~lines 1443-1463): add
     `userId: true` to the project select.
  Then mirror `userId` onto the local `WorkflowRunJob.project` interface in
  `render-clips.ts:74-82` and use `run.project.userId` directly in Step 2
  (no extra prisma query for the project — only the one `user.findUnique`
  for the tier).

**Out of scope**:
- The zod aspect-ratio configs in `packages/validators/src/clip.ts` — leave all
  ratios 1080p; the cap is a post-process, not a config change.
- The studio preview (must keep previewing at full quality; preview parity is
  about captions, not the export container).
- Dub pipeline outputs (dubs mux over an already-rendered MP4 — the source
  render is already watermarked for free users; do not double-process).
- Billing/quota logic; the pricing page (plan 018 owns copy).

## Git workflow

Do NOT commit, branch, stash, or push. Edit the working tree directly and leave
changes uncommitted.

## Steps

### Step 1: Pure helper for the post-process ffmpeg args

In `render-clips.ts`, add an exported pure function (exported so it can be
unit-tested):

```ts
/** Free-tier export treatment: 2/3 downscale (1080p-class → 720p-class) plus a
 *  corner watermark. Returns the ffmpeg args for a single post-process pass. */
export function buildFreeTierPostProcessArgs(params: {
  inputPath: string;
  outputPath: string;
  watermarkText: string; // e.g. "Made with Narriflow"
  fontFilePath?: string | null;
}): string[]
```

Filter chain (single `-vf`):
`scale=trunc(iw*2/3/2)*2:trunc(ih*2/3/2)*2,drawtext=text='<escaped>':fontcolor=white@0.85:borderw=2:bordercolor=black@0.6:fontsize=h/28:x=w-tw-h/40:y=h/40` —
append `:fontfile=<path>` only when `fontFilePath` is set. Escape the text for
drawtext (escape `\`, `'`, `:`, `%`). Audio: `-c:a copy`. Video: match the
encoder settings the existing builders use (grep for `libx264` / `-crf` /
`-preset` in render-clips.ts and reuse the same values).

**Verify**: `bun run typecheck` → exit 0.

### Step 2: Tier lookup once per render run

Near the top of `processClipRenderingRun`, after the project is available,
fetch the owner's tier once:

```ts
const owner = await prisma.user.findUnique({
  where: { id: run.project.userId },
  select: { pricingTier: true },
});
const ownerTier = resolvePricingTier(owner?.pricingTier);
const applyFreeTierTreatment = ownerTier === "free";
```

Use the prisma accessor pattern already used in this file (grep how it gets a
client — worker code imports services or a prisma instance; match it). Import
`resolvePricingTier` from `@narriflow/validators`.

**Verify**: `grep -n "resolvePricingTier" apps/worker/src/tasks/render-clips.ts` → 1 use; `bun run typecheck` → exit 0.

### Step 3: Apply the post-process to every completed output

At the single point where each output file is finalized before upload
(`const outputStat = await stat(params.output.outputPath)` region, ~line 1375):
when `applyFreeTierTreatment` is true, run the Step-1 pass writing to
`<outputPath>.wm.mp4`, then replace the original (rename over it), then proceed
with the existing stat/upload flow unchanged. Wrap in try/catch: on failure,
log `render_watermark_failed` at error level and STOP the run with the
existing worker error type (a free render without watermark must not ship
silently — fail the render like any other ffmpeg failure). Thread
`applyFreeTierTreatment` down to this point the same way other per-run flags
flow (check how `logo`/`music` plans are threaded through params and match).
Also apply to the audiogram path if it finalizes elsewhere — grep for the
audiogram output finalization; if it shares the same stat/upload site, nothing
extra is needed.

**Verify**: `bun run typecheck` → exit 0; `bun run test` → all pass.

### Step 4: Smoke-test locally with a real ffmpeg run

Generate a 3-second test input and run the post-process args end-to-end:

```sh
ffmpeg -y -f lavfi -i testsrc=duration=3:size=1080x1920:rate=30 -f lavfi -i sine=frequency=440:duration=3 -c:v libx264 -pix_fmt yuv420p -c:a aac /tmp/narriflow-wm-in.mp4
```

Then invoke ffmpeg with exactly the args your helper produces (print them from
a tiny `bun -e` script importing the helper). Check the output:
`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 /tmp/narriflow-wm-out.mp4` → `720,1280`.

**Verify**: ffprobe prints `720,1280`; the file plays (non-zero size).

### Step 5: Structured logs

Log once per output when treatment is applied:
`log("info", "free_tier_export_treatment", { workflowRunId: run.id, clipId, width, height })`.

**Verify**: `grep -n "free_tier_export_treatment" apps/worker/src/tasks/render-clips.ts` → 1 match.

## Test plan

New unit tests for `buildFreeTierPostProcessArgs` (model after the existing
pure-function tests in `apps/worker/src/tasks/detect-clips.test.ts`):
1. args contain the scale expression and drawtext with escaped text
   (input containing `'` and `:` is escaped),
2. `-c:a copy` present; input/output paths in the right positions,
3. `fontfile` included only when provided.
Verification: `bun run test` → all pass including the new tests.

## Done criteria

- [ ] `bun run typecheck`, `bun run test`, `bunx @biomejs/biome check .` all exit 0
- [ ] `grep -n "buildFreeTierPostProcessArgs" apps/worker/src/tasks/render-clips.ts` → definition + ≥1 call
- [ ] Step-4 smoke test: ffprobe reports `720,1280` for a 1080×1920 input
- [ ] Paid tiers unaffected: the post-process is gated on `ownerTier === "free"` only
- [ ] Only in-scope files modified (`git status --short`)

## STOP conditions

- There is no single finalization point for outputs (the stat/upload site at
  ~line 1375 doesn't exist or renders upload from multiple sites) — report the
  actual structure instead of scattering the pass across builders.
- `run.project.userId` is not available on the claimed run object.
- drawtext is unavailable in the local ffmpeg build (Step 4 fails with
  "No such filter: drawtext").
- Encoder settings for the re-encode can't be found in the existing builders.

## Maintenance notes

- The Dockerfile's ffmpeg must include drawtext (fontconfig/freetype) — the
  bundled caption fonts imply it does; reviewer should confirm the worker
  image builds and renders once before deploy.
- If a "remove watermark" upsell is later added at the clip level, the gate
  moves from tier-only to tier+entitlement — keep the gate in one place.
- 4K (Pro add-on, roadmap) would slot in as another post-process branch.
- Plan 018 (marketing copy) assumes: watermark + 720p on `free` only; all paid
  tiers get 1080p no-watermark. If you change that decision, tell the reviewer.
