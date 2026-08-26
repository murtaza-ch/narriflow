# Clip Composition Plan rollout

Center, Fit, and Automatic Speaker Composition have independent web and worker controls. Each accepts `legacy`, `shadow`, or `plan`; omitted values default to `shadow`, so a deployment compares safely before explicit cutover.

| Mode | Web (`apps/web/.env.local`) | Worker (`apps/worker/.env`) |
| --- | --- | --- |
| Center | `NEXT_PUBLIC_COMPOSITION_CENTER` | `WORKER_COMPOSITION_CENTER` |
| Fit/background | `NEXT_PUBLIC_COMPOSITION_FIT` | `WORKER_COMPOSITION_FIT` |
| Automatic speakers | `NEXT_PUBLIC_COMPOSITION_AUTO` | `WORKER_COMPOSITION_AUTO` |

`legacy` uses the established adapter path. `shadow` computes and validates a plan, logs only safe version/fingerprint/geometry summaries, and continues to render through the legacy path. `plan` adopts the plan. A bad value fails startup or module initialization rather than silently selecting a mode.

Set `NEXT_PUBLIC_AUTOMATIC_SPEAKER_LAYOUT` to the same `0`/`1` capability as worker `WORKER_LAYOUT_ENGINE`. This mirror lets Studio show an explicit disabled fallback instead of an analysis-pending notice while the worker kill switch is active.

## Rollout

1. Deploy the shared package and both adapters with all six controls set to `shadow`.
2. Exercise Center across all four aspect ratios. Compare command topology and real-media bytes against legacy fixtures; any mismatch blocks promotion.
3. Promote Center web and worker controls to `plan` together.
4. Exercise Fit with a solid color, a valid image, a failed image download, and a failed FFmpeg image command. Confirm both adapters use the selected color for degradation and emit `background_image_unavailable` without exposing the URL.
5. Promote Fit web and worker controls to `plan` together.
6. Exercise Automatic speakers with missing, stale, successful two-speaker, no-split target, disabled-engine, and manual-override evidence. Confirm Studio shows provisional Center while analyzing, Clip Render Attempt fulfills evidence before encoding, and FFmpeg receives either an exact ready plan or an explicit degraded Center plan.
7. Promote Automatic speakers web and worker controls to `plan` together. Watch `clip_composition_plan` and `clip_composition_shadow` structured logs by mode, plan version, notice code, and target; fingerprints are diagnostic identities, not access credentials.

## Rollback

Rollback one mode at a time by setting its web and worker controls to `legacy` and restarting the affected processes. Keep the other modes on `plan`. No database or document migration is required: Clip Editor Documents and persisted automatic-layout evidence remain valid. Unknown plan versions already fail before FFmpeg starts; do not bypass that rejection during rollback.
