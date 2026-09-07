# July 2026 audit — source reports

Six parallel audits plus live browser testing against the authenticated app,
run 2026-07-26 against commit `05d273d`. Everything landed from this pass is
summarised in `ROADMAP.md` (Phase 0); these are the underlying reports, kept
because they contain far more detail than the roadmap entry — including the
competitor evidence and the findings that were **deliberately not** acted on.

| File | What it is |
| --- | --- |
| `00-browser-qa-findings.md` | Live QA against the running app with the real Clerk session. Measured numbers (44s to first frame, 531 MB–1.1 GB sources) and a "verified NOT bugs" list. |
| `02-competitor-teardown.md` | 13 competitors: pricing, processing speed, editor UX, B-roll, captions. Top 15 user pain points with sources, and 20 ranked recommendations. |
| `03-studio-audit.md` | Studio/editor: preview-vs-export parity, state management, performance, a11y. |
| `04-broll-audit.md` | B-roll end to end, with empirical ffmpeg measurements. |
| `05-pipeline-cost-audit.md` | Latency budget per stage, ranked speed wins, cost per source-hour before/after. |
| `06-uiux-audit.md` | Blueline design-system conformance, responsive, WCAG contrast. |
| `research-*.md` | Raw competitor research backing `02`. |

## Reading them critically

These are agent-authored and were **not** all accepted. Three things to keep in
mind:

1. **Some recommendations were rejected on measurement.** The pipeline audit
   proposed parallel clip encoding and hardware acceleration; benchmarking
   showed intra-machine parallelism buys nothing (libx264 already saturates all
   cores: 4 clips parallel = 40.49s vs 39.50s sequential) and VideoToolbox was
   *slower* than `veryfast`. Don't re-propose these without new evidence.
2. **One recommendation was reversed.** Lowering `reasoning.effort` to `low`
   was implemented, measured 46% faster, then reverted to `medium` because the
   same benchmark showed weaker story-completeness scores. The saving was ~1% of
   end-to-end wall clock; clip selection is the core product value.
3. **External prices are unverified.** The AssemblyAI and OpenAI per-hour
   figures in `05` are list prices the agent could not confirm from code. The
   cost model's *structure* holds; the absolute numbers should be re-checked
   before anyone quotes them.

## Not yet acted on

- `attemptCount` is incremented but never read — a stalled job is marked
  permanently failed instead of requeued. `WorkflowRun` has no `attemptCount`
  column at all, so this needs a migration.
- `AutopilotEpisode.projectId` has no `@relation`, so deleting a project leaves
  dangling rows. Harmless today (its dedup key is `[ruleId, episodeId]`) but it
  should be a conscious decision.
- Timeline scrub-thumbnails still stream the full source; only the player moved
  to the preview proxy.
- Audio-only (podcast) sources get no preview proxy.
- The 20 competitor recommendations in `02` are mostly **unimplemented** — this
  pass was correctness and performance, not positioning.
