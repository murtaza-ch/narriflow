# Render pipeline production-readiness audit (owner request 2026-10-29)

Owner: "The rendering pipeline should be most efficient and error free, handle all
the edge cases, optimised, no clip render should fail, scalable and fast, follow
industry good practice, fully production ready."

Scope (AGENTS.md critical path): `apps/worker/src/tasks/clip-render-attempt.ts`,
`apps/worker/src/composition-ffmpeg-adapter.ts`, `apps/worker/src/ffmpeg-*.ts`,
render claiming/finalization in `packages/services/src/workflow-run-lifecycle.ts`
and the clip render/export services, `packages/composition-plan`, preview proxy and
thumbnail stages, the export path (`clip-export.service.ts`), worker poll loops and
health, the Dockerfile (fonts/ffmpeg build), and R2 source/output I/O.

Settled decisions — do NOT re-litigate (from the 2026-07 perf work, Opus+Codex converged):
- Naive parallel clip encodes on one machine buy nothing (in-repo benchmark near
  `apps/worker/src/index.ts` top); levers are ranged source reads, parallel
  multipart, concurrent fragments, STT submit-and-release, clip-group claiming.
- Per-clip WorkflowRuns are ruled out; one parent run + child clip-group leases.
- Drawtext text must go through `drawtextLiteralText` (`apps/worker/src/ffmpeg-text.ts`);
  real-FFmpeg tests must assert stderr has no drawtext errors, not just exit 0.
- Every ClipExportVariant write must end in `syncClipExportAggregates`.
- Retryable render failures stay nonterminal.
- Caption cues come only from `deriveCaptionCues` + `CAPTION_POSITION_Y_DEFAULTS`.
Today's fixes to know: worker DB pool now has connect/query timeouts and a loop
watchdog (`apps/worker/src/poll-loop.ts`, commit ece879e8).

Evidence available: real renders today on project
`53b0d959-968b-49da-aa75-2bb62a17fe23` (YouTube 2reQut8WNGc) — local worker log
`/tmp/worker-dev.log` (clip_render_* telemetry lines), Railway worker logs via
`bunx --bun @railway/cli logs --service @narriflow/worker`, and the shared dev DB
(read-only `psql` with `DIRECT_URL` from `packages/db/.env`): recent
`ClipRender`/`ClipExportVariant`/`WorkflowRun` rows, failure codes and durations.
Measure failure rate and per-clip wall-clock from that data before claiming anything.
