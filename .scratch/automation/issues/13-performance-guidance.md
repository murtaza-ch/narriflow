# 13 - Use performance to guide clip selection

**What to build:** Once a Workspace has enough synced performance data, Narriflow tells moment detection and finishing what tends to work for that audience, says so openly, and can be switched off.

**Blocked by:** [03 - Performance sync](03-performance-sync.md), [04 - Finishing](04-finishing.md).

**Status:** done

## Behavior

- Compute per Workspace, nightly, from the frozen clip-facts snapshots and 7-day counts. For each category, hook strength band, and duration band:
  - median views relative to the Workspace median (lift);
  - sample size.
  Only groups with at least 10 posts and a Workspace total of at least 30 posts count. Store the result with its computed time and sample sizes.
- Detection: when the Workspace has guidance and the setting is on, add one bounded line to the moment-detection prompt naming the top two and bottom one groups with their lifts (`apps/worker/src/tasks/detect-clips.ts` prompt construction). Never more than one line. Never change the scoring scale.
- Finishing: rank picked clips by score multiplied by a bounded lift factor (0.8 to 1.25) when guidance exists. The Project's finishing status shows "ranked with your audience data" and the factors used.
- Workspace setting "Use my performance data to pick clips" (default on once data qualifies). The "What worked" view explains the current guidance.
- Deterministic and explainable: same data, same guidance. No model fine-tuning.

## Acceptance criteria

- [x] Guidance computation is pure and unit-tested, including thresholds and bounds.
- [x] Prompt line appears only with qualifying data and the setting on (unit test on prompt construction).
- [x] Finishing ranking uses bounded factors and records them.
- [x] lint, typecheck, test, `test:workflow:db` pass on the local Postgres.

## Comments

2026-10-24: implemented in a worktree, Opus-reviewed (statistical fixes: views normalized per platform, thresholds count distinct clips, lifts shrunk toward 1 by sample size, last 180 days only, a clip may pass another only within 15 score points, hook strength dropped from the feedback to avoid self-inflation, capped worker query with failure stamping, one exported-duration measure). Spec change: groups are category and length only; `TrackedVideo.clipId` added. Merged; verified in the main checkout: biome, typecheck, `bun run test`, workflow 153, integration-api (finishing 28), social-publication 60, vizard-expansion, clip-editor-persistence. Detection prompt without guidance is byte-identical to the base commit (fixture test).
